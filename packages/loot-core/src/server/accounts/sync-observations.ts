/**
 * Durable staging for bank-sync observations and the review queue.
 *
 * Every source row is first recorded as an observation — the audit evidence a
 * decision can point back to. Observations live in a device-local table
 * (`bank_sync_observations`), because they are re-derivable from the provider;
 * review items and decisions live in synced tables so a decision made on one
 * device is honored on the others.
 *
 * Recording a decision never changes the ledger. `applied_at` stays null until
 * the materialization step has actually applied it, and the UI must present
 * recorded-but-unapplied decisions as exactly that.
 */

import { v4 as uuidv4 } from 'uuid';

import * as db from '#server/db';

export type ObservationSource = 'pluggyai';

export type ReviewItemKind = 'ambiguous-payment' | 'suspected-duplicate';

export type ReviewItemState =
  | 'pending'
  | 'confirmed-single-payment'
  | 'confirmed-separate-payments'
  | 'left-unresolved'
  | 'applied';

export type DecisionAction =
  | 'confirm-single-payment'
  | 'confirm-separate-payments'
  | 'leave-unresolved';

export type ReviewEvidence = {
  /** One compact line per held observation, for display and audit. */
  observations: Array<{
    observationId: string;
    date: string;
    amountCents: number;
    description: string;
    billReference?: string;
    status?: string;
  }>;
  /** Counterparts already present in the ledger or in the same snapshot. */
  candidates?: Array<{
    transactionId: string;
    accountId: string;
    date: string;
    amountCents: number;
    payeeName?: string;
  }>;
  /**
   * Sum of the held observations' amounts in integer cents. This is the upper
   * bound of the uncertainty window, not a precise balance correction.
   */
  heldAmountCents: number;
  /**
   * The single-event scenario for the group: if every held observation turns
   * out to be one payment, this is what the ledger is missing.
   */
  minScenarioAmountCents?: number;
  note?: string;
};

export type ReviewItem = {
  id: string;
  accountId: string;
  kind: ReviewItemKind;
  state: ReviewItemState;
  observationIds: string[];
  evidence: ReviewEvidence | null;
  /**
   * The full raw download rows of the held observations (JSON), so a
   * decision can be materialized on any synced device.
   */
  rawObservations: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Decision = {
  id: string;
  reviewItemId: string;
  action: DecisionAction;
  observationIds: string[];
  decidedAt: string;
  appliedAt: string | null;
};

export type AccountUncertainty = {
  /** Review items whose observations have not reached the ledger yet. */
  pendingCount: number;
  /** Sum of the held observations' amounts, integer cents. */
  heldAmountCents: number;
};

/**
 * Observation <-> canonical event <-> Actual record journal. A mapping with
 * `appliedAt` set is the durable suppression record: its alias observations
 * must never reach the ledger again.
 */
export type EventMapping = {
  id: string;
  reviewItemId: string;
  accountId: string;
  representativeObservationId: string | null;
  aliasObservationIds: string[];
  actualTransactionIds: string[];
  decision: DecisionAction;
  createdAt: string;
  appliedAt: string | null;
};

export function observationId(accountId: string, sourceId: string): string {
  return `${accountId}:${sourceId}`;
}

/**
 * FNV-1a over the payload text. Only used to detect that a source row changed
 * (status transitions, bill reassignment); it is not a security hash.
 */
export function payloadHash(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export type StageObservationsResult = {
  /** Every observation id present in this snapshot. */
  seen: string[];
  /** Ids staged for the first time. */
  added: string[];
  /** Ids whose payload differs from the previously staged revision. */
  changed: string[];
};

/**
 * Records every source observation of one account, idempotently. Re-staging
 * the same snapshot only bumps `last_seen`; a row whose payload changed is
 * reported in `changed` and stored as the new revision.
 */
export async function stageObservations(
  accountId: string,
  source: ObservationSource,
  observations: ReadonlyArray<{ sourceId: string; payload: string }>,
): Promise<StageObservationsResult> {
  const now = new Date().toISOString();
  const seen: string[] = [];
  const added: string[] = [];
  const changed: string[] = [];

  for (const observation of observations) {
    const id = observationId(accountId, observation.sourceId);
    const hash = payloadHash(observation.payload);
    const existing = await db.first<{ payload_hash: string }>(
      'SELECT payload_hash FROM bank_sync_observations WHERE id = ?',
      [id],
    );

    if (existing == null) {
      await db.run(
        `INSERT INTO bank_sync_observations
           (id, account_id, source, source_id, first_seen, last_seen, payload, payload_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          accountId,
          source,
          observation.sourceId,
          now,
          now,
          observation.payload,
          hash,
        ],
      );
      added.push(id);
    } else if (existing.payload_hash !== hash) {
      await db.run(
        `UPDATE bank_sync_observations
           SET last_seen = ?, payload = ?, payload_hash = ?
         WHERE id = ?`,
        [now, observation.payload, hash, id],
      );
      changed.push(id);
    } else {
      await db.run(
        'UPDATE bank_sync_observations SET last_seen = ? WHERE id = ?',
        [now, id],
      );
    }

    seen.push(id);
  }

  return { seen, added, changed };
}

type DbReviewItem = {
  id: string;
  account_id: string | null;
  kind: string | null;
  state: string | null;
  observation_ids: string | null;
  evidence: string | null;
  raw_observations: string | null;
  created_at: string | null;
  updated_at: string | null;
  tombstone: number | null;
};

type DbDecision = {
  id: string;
  review_item_id: string | null;
  action: string | null;
  observation_ids: string | null;
  decided_at: string | null;
  applied_at: string | null;
  tombstone: number | null;
};

function parseJson(value: string | null): unknown {
  if (value == null || value === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

function isReviewEvidence(value: unknown): value is ReviewEvidence {
  return (
    value != null &&
    typeof value === 'object' &&
    'heldAmountCents' in value &&
    'observations' in value
  );
}

function parseEvidence(value: string | null): ReviewEvidence | null {
  const parsed = parseJson(value);
  return isReviewEvidence(parsed) ? parsed : null;
}

function isReviewItemKind(value: unknown): value is ReviewItemKind {
  return value === 'ambiguous-payment' || value === 'suspected-duplicate';
}

function isReviewItemState(value: unknown): value is ReviewItemState {
  return (
    value === 'pending' ||
    value === 'confirmed-single-payment' ||
    value === 'confirmed-separate-payments' ||
    value === 'left-unresolved' ||
    value === 'applied'
  );
}

function isDecisionAction(value: unknown): value is DecisionAction {
  return (
    value === 'confirm-single-payment' ||
    value === 'confirm-separate-payments' ||
    value === 'leave-unresolved'
  );
}

function toReviewItem(row: DbReviewItem): ReviewItem {
  return {
    id: row.id,
    accountId: row.account_id ?? '',
    kind: isReviewItemKind(row.kind) ? row.kind : 'ambiguous-payment',
    state: isReviewItemState(row.state) ? row.state : 'pending',
    observationIds: parseStringArray(row.observation_ids),
    evidence: parseEvidence(row.evidence),
    rawObservations: row.raw_observations,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

export async function createReviewItem(
  accountId: string,
  kind: ReviewItemKind,
  observationIds: string[],
  evidence: ReviewEvidence,
  rawObservations?: string | null,
): Promise<string> {
  const id = uuidv4();
  const now = new Date().toISOString();
  await db.insert('bank_sync_review_items', {
    id,
    account_id: accountId,
    kind,
    state: 'pending',
    observation_ids: JSON.stringify(observationIds),
    evidence: JSON.stringify(evidence),
    raw_observations: rawObservations ?? null,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function getReviewItems(
  accountId?: string,
): Promise<ReviewItem[]> {
  const rows = await db.all<DbReviewItem>(
    accountId == null
      ? 'SELECT * FROM bank_sync_review_items WHERE tombstone = 0 ORDER BY created_at'
      : 'SELECT * FROM bank_sync_review_items WHERE tombstone = 0 AND account_id = ? ORDER BY created_at',
    accountId == null ? [] : [accountId],
  );
  return rows.map(toReviewItem);
}

export async function getReviewItem(id: string): Promise<ReviewItem | null> {
  const row = await db.first<DbReviewItem>(
    'SELECT * FROM bank_sync_review_items WHERE id = ? AND tombstone = 0',
    [id],
  );
  return row ? toReviewItem(row) : null;
}

export async function updateReviewItemState(
  id: string,
  state: ReviewItemState,
): Promise<void> {
  await db.update('bank_sync_review_items', {
    id,
    state,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Records what the user decided. This is a journal entry, not a ledger change:
 * `applied_at` stays null until the materialization step applies it.
 */
export async function recordDecision(
  reviewItemId: string,
  action: DecisionAction,
  observationIds: string[],
): Promise<string> {
  const id = uuidv4();
  await db.insert('bank_sync_decisions', {
    id,
    review_item_id: reviewItemId,
    action,
    observation_ids: JSON.stringify(observationIds),
    decided_at: new Date().toISOString(),
  });
  return id;
}

export async function getDecisions(reviewItemId?: string): Promise<Decision[]> {
  const rows = await db.all<DbDecision>(
    reviewItemId == null
      ? 'SELECT * FROM bank_sync_decisions WHERE tombstone = 0 ORDER BY decided_at'
      : 'SELECT * FROM bank_sync_decisions WHERE tombstone = 0 AND review_item_id = ? ORDER BY decided_at',
    reviewItemId == null ? [] : [reviewItemId],
  );
  return rows.map(row => ({
    id: row.id,
    reviewItemId: row.review_item_id ?? '',
    action: isDecisionAction(row.action) ? row.action : 'leave-unresolved',
    observationIds: parseStringArray(row.observation_ids),
    decidedAt: row.decided_at ?? '',
    appliedAt: row.applied_at,
  }));
}

/**
 * The uncertainty state of one account: how many review items are still not
 * applied, and the size of the held window. While this is non-zero the account
 * balance is knowingly incomplete and must be presented as such.
 */
export async function getAccountUncertainty(
  accountId: string,
): Promise<AccountUncertainty> {
  const items = await getReviewItems(accountId);
  const pending = items.filter(item => item.state !== 'applied');
  const heldAmountCents = pending.reduce(
    (total, item) => total + (item.evidence?.heldAmountCents ?? 0),
    0,
  );
  return { pendingCount: pending.length, heldAmountCents };
}

export async function isAccountIncomplete(accountId: string): Promise<boolean> {
  const { pendingCount } = await getAccountUncertainty(accountId);
  return pendingCount > 0;
}

type DbEventMapping = {
  id: string;
  review_item_id: string | null;
  account_id: string | null;
  representative_observation_id: string | null;
  alias_observation_ids: string | null;
  actual_transaction_ids: string | null;
  decision: string | null;
  created_at: string | null;
  applied_at: string | null;
  tombstone: number | null;
};

function toEventMapping(row: DbEventMapping): EventMapping {
  return {
    id: row.id,
    reviewItemId: row.review_item_id ?? '',
    accountId: row.account_id ?? '',
    representativeObservationId: row.representative_observation_id,
    aliasObservationIds: parseStringArray(row.alias_observation_ids),
    actualTransactionIds: parseStringArray(row.actual_transaction_ids),
    decision: isDecisionAction(row.decision)
      ? row.decision
      : 'leave-unresolved',
    createdAt: row.created_at ?? '',
    appliedAt: row.applied_at,
  };
}

export async function createEventMapping({
  reviewItemId,
  accountId,
  representativeObservationId,
  aliasObservationIds,
  actualTransactionIds,
  decision,
  appliedAt,
}: {
  reviewItemId: string;
  accountId: string;
  representativeObservationId: string | null;
  aliasObservationIds: string[];
  actualTransactionIds: string[];
  decision: DecisionAction;
  appliedAt?: string | null;
}): Promise<string> {
  const id = uuidv4();
  await db.insert('bank_sync_event_mappings', {
    id,
    review_item_id: reviewItemId,
    account_id: accountId,
    representative_observation_id: representativeObservationId,
    alias_observation_ids: JSON.stringify(aliasObservationIds),
    actual_transaction_ids: JSON.stringify(actualTransactionIds),
    decision,
    created_at: new Date().toISOString(),
    applied_at: appliedAt ?? null,
  });
  return id;
}

export async function getEventMappings(
  accountId?: string,
): Promise<EventMapping[]> {
  const rows = await db.all<DbEventMapping>(
    accountId == null
      ? 'SELECT * FROM bank_sync_event_mappings WHERE tombstone = 0 ORDER BY created_at'
      : 'SELECT * FROM bank_sync_event_mappings WHERE tombstone = 0 AND account_id = ? ORDER BY created_at',
    accountId == null ? [] : [accountId],
  );
  return rows.map(toEventMapping);
}

export async function getEventMappingByReviewItem(
  reviewItemId: string,
): Promise<EventMapping | null> {
  const row = await db.first<DbEventMapping>(
    'SELECT * FROM bank_sync_event_mappings WHERE review_item_id = ? AND tombstone = 0',
    [reviewItemId],
  );
  return row ? toEventMapping(row) : null;
}

/**
 * Observation ids that must never reach the ledger again: aliases of applied
 * events. Enforced before matching, so a suppressed duplicate cannot silently
 * return under a new Actual id.
 */
export async function getSuppressedObservationIds(
  accountId: string,
): Promise<Set<string>> {
  const rows = await db.all<DbEventMapping>(
    `SELECT * FROM bank_sync_event_mappings
      WHERE tombstone = 0 AND account_id = ? AND applied_at IS NOT NULL`,
    [accountId],
  );
  const suppressed = new Set<string>();
  for (const row of rows) {
    for (const id of parseStringArray(row.alias_observation_ids)) {
      suppressed.add(id);
    }
  }
  return suppressed;
}

export async function markDecisionApplied(decisionId: string): Promise<void> {
  await db.update('bank_sync_decisions', {
    id: decisionId,
    applied_at: new Date().toISOString(),
  });
}
