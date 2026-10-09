/**
 * Pluggy-specific duplicate-payment detection and the staging/queue
 * orchestration it drives.
 *
 * Live evidence (PLUGGY_SYNC_RCA.md §2.1): one card payment can be reported by
 * Pluggy as two card credits with the same amount and date — same source-level
 * event, different bill linkage — and importing both silently overstates the
 * card credit. This module detects the *shape* of that problem and holds the
 * rows out of the ledger; it never decides which representation is canonical.
 * Equivalence stays a user decision (or, later, a verified connector rule).
 *
 * Detection is deliberately structural: same amount, same or adjacent date,
 * positive (credit) rows that carry credit-card metadata. Description text is
 * never used as a criterion.
 */

import * as db from '#server/db';
import { amountToInteger } from '#shared/util';

import {
  createReviewItem,
  getReviewItems,
  getSuppressedObservationIds,
  observationId,
  stageObservations,
} from './sync-observations';
import type { ReviewEvidence } from './sync-observations';

/**
 * The subset of a normalized bank-sync row this module reads. Everything else
 * (flattened Pluggy fields such as `creditCardMetadata.billId`) is passed
 * through untouched and only used as evidence.
 */
export type PluggySyncRow = {
  transactionId: string;
  date: string;
  transactionAmount?: { amount: number; currency?: string } | null;
  payeeName?: string | null;
  notes?: string | null;
  [sourceField: string]: unknown;
};

export type CandidateGroup = {
  /** Indexes into the input row array. */
  indexes: number[];
  amountCents: number;
};

const CARD_METADATA_PREFIX = 'creditCardMetadata.';
const DAY_MS = 86_400_000;

function hasCardMetadata(row: PluggySyncRow): boolean {
  return Object.keys(row).some(key => key.startsWith(CARD_METADATA_PREFIX));
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function dayToDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The integer YYYYMMDD form the transactions table stores dates in. */
function dayToInt(day: number): number {
  return Number(dayToDate(day).replace(/-/g, ''));
}

function intToDate(value: number): string {
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/**
 * Finds groups of card credits that may be duplicate representations of one
 * payment: positive amounts, integer-equal, dates within one day of each
 * other, every member carrying credit-card metadata.
 */
export function findDuplicatePaymentGroups(
  rows: PluggySyncRow[],
): CandidateGroup[] {
  const candidates: Array<{ index: number; day: number; amountCents: number }> =
    [];

  rows.forEach((row, index) => {
    if (
      !hasCardMetadata(row) ||
      typeof row.date !== 'string' ||
      typeof row.transactionAmount?.amount !== 'number'
    ) {
      return;
    }
    const amountCents = amountToInteger(row.transactionAmount.amount);
    if (amountCents <= 0) {
      return;
    }
    candidates.push({ index, day: dayNumber(row.date), amountCents });
  });

  const byAmount = new Map<number, Array<{ index: number; day: number }>>();
  for (const candidate of candidates) {
    const list = byAmount.get(candidate.amountCents) ?? [];
    list.push({ index: candidate.index, day: candidate.day });
    byAmount.set(candidate.amountCents, list);
  }

  const groups: CandidateGroup[] = [];
  for (const [amountCents, list] of byAmount) {
    list.sort((a, b) => a.day - b.day);
    let cluster: Array<{ index: number; day: number }> = [];
    const flush = () => {
      if (cluster.length >= 2) {
        groups.push({
          indexes: cluster.map(item => item.index),
          amountCents,
        });
      }
      cluster = [];
    };
    for (const item of list) {
      if (
        cluster.length > 0 &&
        item.day - cluster[cluster.length - 1].day > 1
      ) {
        flush();
      }
      cluster.push(item);
    }
    flush();
  }

  return groups;
}

export type ReviewPluggySyncResult = {
  /** Transaction ids that must not reach the ledger until reviewed. */
  heldTransactionIds: Set<string>;
  /**
   * Transaction ids that are aliases of already-applied events. They must
   * never reach the ledger again, even after deletion or id churn.
   */
  suppressedTransactionIds: Set<string>;
  /** Review items created by this run (already-queued groups are skipped). */
  reviewItemIds: string[];
};

/**
 * Stages every observation of one Pluggy account and holds the ambiguous card
 * credits out of the ledger. Idempotent: re-running with the same snapshot
 * neither re-stages payloads nor duplicates review items.
 */
export async function reviewPluggySync(
  accountId: string,
  rows: PluggySyncRow[],
): Promise<ReviewPluggySyncResult> {
  await stageObservations(
    accountId,
    'pluggyai',
    rows
      .filter(
        (row): row is PluggySyncRow & { transactionId: string } =>
          typeof row.transactionId === 'string' && row.transactionId !== '',
      )
      .map(row => ({
        sourceId: row.transactionId,
        payload: JSON.stringify(row),
      })),
  );

  // Observations that are aliases of an applied decision never take part in
  // matching, holding, or import again.
  const suppressed = await getSuppressedObservationIds(accountId);
  const suppressedTransactionIds = new Set<string>();
  const eligibleRows = rows.filter(row => {
    const id = observationId(accountId, row.transactionId);
    if (suppressed.has(id)) {
      suppressedTransactionIds.add(row.transactionId);
      return false;
    }
    return true;
  });

  const groups = findDuplicatePaymentGroups(eligibleRows);
  if (groups.length === 0) {
    return {
      heldTransactionIds: new Set(),
      suppressedTransactionIds,
      reviewItemIds: [],
    };
  }

  const existing = await getReviewItems(accountId);
  const covered = new Set<string>();
  const applied = new Set<string>();
  for (const item of existing) {
    for (const id of item.observationIds) {
      covered.add(id);
      if (item.state === 'applied') {
        applied.add(id);
      }
    }
  }

  const heldTransactionIds = new Set<string>();
  const reviewItemIds: string[] = [];

  for (const group of groups) {
    const groupRows = group.indexes.map(index => eligibleRows[index]);
    const observationIds = groupRows.map(row =>
      observationId(accountId, row.transactionId),
    );

    // Held unless an applied decision already resolved the group; the applied
    // path is responsible for materialization and alias suppression.
    if (!observationIds.every(id => applied.has(id))) {
      for (const row of groupRows) {
        heldTransactionIds.add(row.transactionId);
      }
    }

    if (observationIds.every(id => covered.has(id))) {
      continue;
    }

    const evidence = await buildEvidence(
      accountId,
      groupRows,
      group.amountCents,
    );
    const itemId = await createReviewItem(
      accountId,
      'ambiguous-payment',
      observationIds,
      evidence,
      JSON.stringify(groupRows),
    );
    reviewItemIds.push(itemId);
    for (const id of observationIds) {
      covered.add(id);
    }
  }

  return { heldTransactionIds, suppressedTransactionIds, reviewItemIds };
}

async function buildEvidence(
  accountId: string,
  groupRows: PluggySyncRow[],
  amountCents: number,
): Promise<ReviewEvidence> {
  const observations = groupRows.map(row => {
    const billId = row['creditCardMetadata.billId'];
    const status = row.status;
    return {
      observationId: observationId(accountId, row.transactionId),
      date: row.date,
      amountCents,
      description: row.payeeName ?? row.notes ?? '',
      billReference: typeof billId === 'string' ? billId : undefined,
      status: typeof status === 'string' ? status : undefined,
    };
  });

  // Counterparts already in the ledger: an opposite amount in another account
  // within a settlement window. Evidence for the reviewer, never a merge
  // criterion.
  const day = dayNumber(groupRows[0].date);
  const candidates = await db.all<{
    id: string;
    account: string;
    date: number;
    amount: number;
    payee_name: string | null;
  }>(
    `SELECT t.id, t.account, t.date, t.amount, p.name AS payee_name
       FROM v_transactions_internal_alive t
       LEFT JOIN payees p ON p.id = t.payee
      WHERE t.account != ?
        AND t.amount = ?
        AND t.date >= ?
        AND t.date <= ?
      LIMIT 5`,
    [accountId, -amountCents, dayToInt(day - 3), dayToInt(day + 3)],
  );

  return {
    observations,
    candidates: candidates.map(candidate => ({
      transactionId: candidate.id,
      accountId: candidate.account,
      date: intToDate(candidate.date),
      amountCents: candidate.amount,
      payeeName: candidate.payee_name ?? undefined,
    })),
    heldAmountCents: amountCents * groupRows.length,
    minScenarioAmountCents: amountCents,
    note:
      'Multiple card credits with the same amount and date may be duplicate ' +
      'representations of one payment. They are held out of the ledger until ' +
      'this is resolved.',
  };
}
