import * as db from '#server/db';

import {
  createReviewItem,
  getAccountUncertainty,
  getDecisions,
  getReviewItems,
  recordDecision,
  stageObservations,
  updateReviewItemState,
} from './sync-observations';
import type { ReviewEvidence } from './sync-observations';

const { emptyDatabase } = global as typeof globalThis & {
  emptyDatabase: () => () => Promise<void>;
};

beforeEach(async () => {
  await emptyDatabase()();
});

const observation = (
  sourceId: string,
  extra: Record<string, unknown> = {},
) => ({
  sourceId,
  payload: JSON.stringify({ id: sourceId, amount: 100, ...extra }),
});

const evidence = (heldAmountCents = 10000): ReviewEvidence => ({
  observations: [
    {
      observationId: 'acct-1:src-1',
      date: '2026-09-25',
      amountCents: heldAmountCents,
      description: 'Pagamento recebido',
    },
  ],
  heldAmountCents,
});

describe('stageObservations', () => {
  test('stages new observations once and reports them as added', async () => {
    const result = await stageObservations('acct-1', 'pluggyai', [
      observation('src-1'),
      observation('src-2'),
    ]);

    expect(result.added).toEqual(['acct-1:src-1', 'acct-1:src-2']);
    expect(result.changed).toEqual([]);

    const rows = await db.all<{ source_id: string }>(
      'SELECT source_id FROM bank_sync_observations ORDER BY source_id',
    );
    expect(rows.map(row => row.source_id)).toEqual(['src-1', 'src-2']);
  });

  test('re-staging an unchanged snapshot only bumps last_seen', async () => {
    await stageObservations('acct-1', 'pluggyai', [observation('src-1')]);
    const before = await db.first<{ payload_hash: string }>(
      'SELECT payload_hash FROM bank_sync_observations WHERE id = ?',
      ['acct-1:src-1'],
    );

    const result = await stageObservations('acct-1', 'pluggyai', [
      observation('src-1'),
    ]);

    expect(result.added).toEqual([]);
    expect(result.changed).toEqual([]);
    const after = await db.first<{ payload_hash: string }>(
      'SELECT payload_hash FROM bank_sync_observations WHERE id = ?',
      ['acct-1:src-1'],
    );
    expect(after?.payload_hash).toBe(before?.payload_hash);
  });

  test('reports a changed payload as changed and stores the new revision', async () => {
    await stageObservations('acct-1', 'pluggyai', [observation('src-1')]);

    const result = await stageObservations('acct-1', 'pluggyai', [
      observation('src-1', { status: 'POSTED' }),
    ]);

    expect(result.changed).toEqual(['acct-1:src-1']);
    const stored = await db.first<{ payload: string }>(
      'SELECT payload FROM bank_sync_observations WHERE id = ?',
      ['acct-1:src-1'],
    );
    expect(stored?.payload).toContain('POSTED');
  });
});

describe('review items and decisions', () => {
  test('creates a review item, lists it, and parses its evidence', async () => {
    const id = await createReviewItem(
      'acct-1',
      'ambiguous-payment',
      ['acct-1:src-1', 'acct-1:src-2'],
      evidence(),
    );

    const items = await getReviewItems('acct-1');

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].state).toBe('pending');
    expect(items[0].observationIds).toEqual(['acct-1:src-1', 'acct-1:src-2']);
    expect(items[0].evidence?.heldAmountCents).toBe(10000);
  });

  test('records a decision without applying it to the ledger', async () => {
    const itemId = await createReviewItem(
      'acct-1',
      'ambiguous-payment',
      ['acct-1:src-1'],
      evidence(),
    );

    const decisionId = await recordDecision(itemId, 'confirm-single-payment', [
      'acct-1:src-1',
    ]);

    const decisions = await getDecisions(itemId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe(decisionId);
    expect(decisions[0].action).toBe('confirm-single-payment');
    expect(decisions[0].appliedAt).toBeNull();
  });

  test('account uncertainty counts every item that is not applied yet', async () => {
    const itemId = await createReviewItem(
      'acct-1',
      'ambiguous-payment',
      ['acct-1:src-1'],
      evidence(),
    );
    await createReviewItem('acct-2', 'suspected-duplicate', ['acct-2:src-9'], {
      ...evidence(500),
      observations: [],
    });

    expect(await getAccountUncertainty('acct-1')).toEqual({
      pendingCount: 1,
      heldAmountCents: 10000,
    });

    await updateReviewItemState(itemId, 'applied');

    expect(await getAccountUncertainty('acct-1')).toEqual({
      pendingCount: 0,
      heldAmountCents: 0,
    });
  });
});
