/**
 * Materializes a recorded review decision.
 *
 * A recorded decision is a journal entry; this module is what applies it to
 * the ledger: the held observations are imported through the normal
 * reconciliation path, exactly once, and the observation -> event -> record
 * mapping is written durably. Aliases of an applied single-payment decision
 * are suppressed from then on (see `getSuppressedObservationIds`), so the
 * same duplicate can never silently return.
 *
 * Applying is idempotent and safe to retry: reconciliation matches by
 * imported id, the mapping is created once, and the decision's `applied_at`
 * is only set after the ledger work is done.
 */

import { reconcileTransactions } from './sync';
import {
  createEventMapping,
  getDecisions,
  getEventMappingByReviewItem,
  getReviewItem,
  markDecisionApplied,
  observationId,
  updateReviewItemState,
} from './sync-observations';

type RawObservationRow = {
  transactionId: string;
  date: string;
  transactionAmount?: { amount: number; currency?: string } | null;
  payeeName?: string | null;
  notes?: string | null;
  booked?: boolean;
  [sourceField: string]: unknown;
};

export type ApplyReviewResult = {
  status: 'applied' | 'already-applied' | 'nothing-to-apply';
  importedTransactionIds: string[];
  aliasObservationIds: string[];
};

function isRawObservationRow(row: unknown): row is RawObservationRow {
  return (
    row != null &&
    typeof row === 'object' &&
    'transactionId' in row &&
    typeof row.transactionId === 'string'
  );
}

function parseRawObservations(raw: string | null): RawObservationRow[] | null {
  if (raw == null || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(isRawObservationRow);
  } catch {
    return null;
  }
}

/**
 * Prefer the posted observation; among equals, the earliest date, then a
 * stable id order. Deterministic so repeated applies pick the same record.
 */
function chooseRepresentative(
  observationIds: string[],
  rowsById: Map<string, RawObservationRow>,
): { id: string; row: RawObservationRow } | null {
  const candidates = observationIds
    .map(id => ({ id, row: rowsById.get(id) }))
    .filter(
      (candidate): candidate is { id: string; row: RawObservationRow } =>
        candidate.row != null,
    );

  const sorted = candidates.sort((a, b) => {
    const bookedA = a.row.booked === true ? 0 : 1;
    const bookedB = b.row.booked === true ? 0 : 1;
    if (bookedA !== bookedB) {
      return bookedA - bookedB;
    }
    const dateA = String(a.row.date ?? '');
    const dateB = String(b.row.date ?? '');
    if (dateA !== dateB) {
      return dateA < dateB ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  return sorted[0] ?? null;
}

export async function applyReviewDecision(
  reviewItemId: string,
): Promise<ApplyReviewResult> {
  const item = await getReviewItem(reviewItemId);
  if (!item) {
    throw new Error('Review item not found');
  }
  if (item.state === 'applied') {
    return {
      status: 'already-applied',
      importedTransactionIds: [],
      aliasObservationIds: [],
    };
  }

  const decisions = await getDecisions(reviewItemId);
  const decision = decisions[decisions.length - 1];
  if (!decision) {
    throw new Error('No decision recorded for this review item');
  }
  if (decision.appliedAt != null) {
    await updateReviewItemState(reviewItemId, 'applied');
    return {
      status: 'already-applied',
      importedTransactionIds: [],
      aliasObservationIds: [],
    };
  }
  if (decision.action === 'leave-unresolved') {
    return {
      status: 'nothing-to-apply',
      importedTransactionIds: [],
      aliasObservationIds: [],
    };
  }

  const rawRows = parseRawObservations(item.rawObservations);
  if (rawRows == null) {
    throw new Error('Review item has no raw observations; cannot apply safely');
  }
  const rowsById = new Map(
    rawRows.map(row => [observationId(item.accountId, row.transactionId), row]),
  );

  const bankSyncOptions = {
    isBankSyncAccount: true,
    strictIdChecking: false,
  } as const;

  if (decision.action === 'confirm-single-payment') {
    const representative = chooseRepresentative(item.observationIds, rowsById);
    if (representative == null) {
      throw new Error(
        'None of the held observations are available; cannot apply safely',
      );
    }

    const result = await reconcileTransactions(
      item.accountId,
      [representative.row],
      bankSyncOptions,
    );
    const importedTransactionIds = [...result.added, ...result.updated];
    const aliasObservationIds = item.observationIds.filter(
      id => id !== representative.id,
    );

    const existing = await getEventMappingByReviewItem(reviewItemId);
    if (!existing) {
      await createEventMapping({
        reviewItemId,
        accountId: item.accountId,
        representativeObservationId: representative.id,
        aliasObservationIds,
        actualTransactionIds: importedTransactionIds,
        decision: decision.action,
        appliedAt: new Date().toISOString(),
      });
    }
    await markDecisionApplied(decision.id);
    await updateReviewItemState(reviewItemId, 'applied');

    return {
      status: 'applied',
      importedTransactionIds,
      aliasObservationIds,
    };
  }

  // confirm-separate-payments: every held observation is a real event.
  const importRows = item.observationIds
    .map(id => rowsById.get(id))
    .filter((row): row is RawObservationRow => row != null);
  if (importRows.length === 0) {
    throw new Error(
      'None of the held observations are available; cannot apply safely',
    );
  }

  const result = await reconcileTransactions(
    item.accountId,
    importRows,
    bankSyncOptions,
  );
  const importedTransactionIds = [...result.added, ...result.updated];

  const existing = await getEventMappingByReviewItem(reviewItemId);
  if (!existing) {
    await createEventMapping({
      reviewItemId,
      accountId: item.accountId,
      representativeObservationId: null,
      aliasObservationIds: [],
      actualTransactionIds: importedTransactionIds,
      decision: decision.action,
      appliedAt: new Date().toISOString(),
    });
  }
  await markDecisionApplied(decision.id);
  await updateReviewItemState(reviewItemId, 'applied');

  return {
    status: 'applied',
    importedTransactionIds,
    aliasObservationIds: [],
  };
}
