import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { runHandler } from '#server/mutators';
import { loadRules } from '#server/transactions/transaction-rules';

import { app as accountsApp } from './app';
import type { PluggySyncRow } from './pluggy-sync-review';
import { processBankSyncDownload } from './sync';
import {
  createReviewItem,
  getDecisions,
  getEventMappings,
  getReviewItems,
  recordDecision,
} from './sync-observations';
import type { ReviewEvidence } from './sync-observations';

// Tests for materialization (PLAN.md step 4): applying a recorded decision
// imports the held observations exactly once, writes the durable mapping, and
// suppresses aliases so duplicates cannot silently return.

const { emptyDatabase } = global as typeof globalThis & {
  emptyDatabase: () => () => Promise<void>;
};

beforeEach(async () => {
  await emptyDatabase()();
  await loadMappings();
  await loadRules();
});

function cardRow(
  transactionId: string,
  date: string,
  amountCents: number,
  extra: Record<string, unknown> = {},
): PluggySyncRow {
  return {
    transactionId,
    date,
    payeeName: 'Pagamento recebido',
    notes: '',
    booked: true,
    status: 'POSTED',
    'creditCardMetadata.billId': 'bill-1',
    transactionAmount: { amount: amountCents / 100, currency: 'BRL' },
    ...extra,
  };
}

function evidence(rows: PluggySyncRow[]): ReviewEvidence {
  return {
    observations: rows.map(row => ({
      observationId: String(row.transactionId),
      date: row.date,
      amountCents: 10000,
      description: String(row.payeeName ?? ''),
    })),
    heldAmountCents: 10000 * rows.length,
    minScenarioAmountCents: 10000,
  };
}

async function setupAccounts() {
  await db.insertAccount({ id: 'bank', name: 'Nubank' });
  await db.insertPayee({
    id: 'transfer-bank',
    name: '',
    transfer_acct: 'bank',
  });
  await db.insertAccount({ id: 'card', name: 'Credit Card' });
  await db.insertPayee({
    id: 'transfer-card',
    name: '',
    transfer_acct: 'card',
  });
}

function aliveTransactions(account: string) {
  return db.all<{ id: string; amount: number; imported_id: string | null }>(
    `SELECT id, amount, imported_id
       FROM v_transactions_internal
      WHERE account = ? AND tombstone = 0
      ORDER BY id`,
    [account],
  );
}

const applyHandler = accountsApp.handlers['bank-sync-review-apply'];

function twinRows() {
  const posted = cardRow('twin-a', '2026-09-25', 10000, {
    status: 'POSTED',
    'creditCardMetadata.billId': 'closed-bill-A',
  });
  const pending = cardRow('twin-b', '2026-09-25', 10000, {
    status: 'PENDING',
    booked: false,
    'creditCardMetadata.billId': 'open-forecast-B',
  });
  return { posted, pending };
}

async function createTwinItem() {
  const { posted, pending } = twinRows();
  const rows = [posted, pending];
  const itemId = await createReviewItem(
    'card',
    'ambiguous-payment',
    ['card:twin-a', 'card:twin-b'],
    evidence(rows),
    JSON.stringify(rows),
  );
  return { itemId, rows };
}

describe('applyReviewDecision', () => {
  test('confirm-single-payment imports one credit (posted preferred) and records the alias', async () => {
    await setupAccounts();
    const { itemId } = await createTwinItem();
    await recordDecision(itemId, 'confirm-single-payment', [
      'card:twin-a',
      'card:twin-b',
    ]);

    const result = await runHandler(applyHandler, { reviewItemId: itemId });

    expect(result.status).toBe('applied');
    expect(result.importedTransactionIds).toHaveLength(1);
    expect(result.aliasObservationIds).toEqual(['card:twin-b']);

    const ledger = await aliveTransactions('card');
    expect(ledger).toHaveLength(1);
    // The posted observation wins over the pending one.
    expect(ledger[0].imported_id).toBe('twin-a');

    const items = await getReviewItems('card');
    expect(items[0].state).toBe('applied');

    const decisions = await getDecisions(itemId);
    expect(decisions[0].appliedAt).not.toBeNull();

    const mappings = await getEventMappings('card');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].representativeObservationId).toBe('card:twin-a');
    expect(mappings[0].aliasObservationIds).toEqual(['card:twin-b']);
    expect(mappings[0].actualTransactionIds).toEqual(
      result.importedTransactionIds,
    );
  });

  test('a suppressed alias does not return on the next sync', async () => {
    await setupAccounts();
    const { itemId, rows } = await createTwinItem();
    await recordDecision(itemId, 'confirm-single-payment', [
      'card:twin-a',
      'card:twin-b',
    ]);
    await runHandler(applyHandler, { reviewItemId: itemId });

    const acctRow = { account_sync_source: 'pluggyai', offbudget: 0 };
    await processBankSyncDownload(
      { startingBalance: 10000, transactions: rows },
      'card',
      acctRow,
    );

    const ledger = await aliveTransactions('card');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].imported_id).toBe('twin-a');

    // No new review item was queued either.
    const items = await getReviewItems('card');
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('applied');
  });

  test('confirm-separate-payments imports both observations', async () => {
    await setupAccounts();
    const { itemId } = await createTwinItem();
    await recordDecision(itemId, 'confirm-separate-payments', [
      'card:twin-a',
      'card:twin-b',
    ]);

    const result = await runHandler(applyHandler, { reviewItemId: itemId });

    expect(result.status).toBe('applied');

    const ledger = await aliveTransactions('card');
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map(row => row.imported_id))).toEqual(
      new Set(['twin-a', 'twin-b']),
    );

    const mappings = await getEventMappings('card');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].representativeObservationId).toBeNull();
    expect(mappings[0].aliasObservationIds).toEqual([]);
  });

  test('leave-unresolved applies nothing and keeps the item unapplied', async () => {
    await setupAccounts();
    const { itemId } = await createTwinItem();
    await runHandler(accountsApp.handlers['bank-sync-review-decide'], {
      reviewItemId: itemId,
      action: 'leave-unresolved',
    });

    const result = await runHandler(applyHandler, { reviewItemId: itemId });

    expect(result.status).toBe('nothing-to-apply');
    expect(await aliveTransactions('card')).toHaveLength(0);

    const items = await getReviewItems('card');
    expect(items[0].state).toBe('left-unresolved');
    expect(await getEventMappings('card')).toHaveLength(0);
  });

  test('applying twice is idempotent', async () => {
    await setupAccounts();
    const { itemId } = await createTwinItem();
    await recordDecision(itemId, 'confirm-single-payment', [
      'card:twin-a',
      'card:twin-b',
    ]);

    await runHandler(applyHandler, { reviewItemId: itemId });
    const second = await runHandler(applyHandler, { reviewItemId: itemId });

    expect(second.status).toBe('already-applied');
    expect(await aliveTransactions('card')).toHaveLength(1);
    expect(await getEventMappings('card')).toHaveLength(1);
  });

  test('refuses to apply without a recorded decision', async () => {
    await setupAccounts();
    const { itemId } = await createTwinItem();

    await expect(
      runHandler(applyHandler, { reviewItemId: itemId }),
    ).rejects.toThrow('No decision recorded');
  });

  test('refuses to apply when raw observations are missing', async () => {
    await setupAccounts();
    const { posted, pending } = twinRows();
    const itemId = await createReviewItem(
      'card',
      'ambiguous-payment',
      ['card:twin-a', 'card:twin-b'],
      evidence([posted, pending]),
    );
    await recordDecision(itemId, 'confirm-single-payment', [
      'card:twin-a',
      'card:twin-b',
    ]);

    await expect(
      runHandler(applyHandler, { reviewItemId: itemId }),
    ).rejects.toThrow('no raw observations');
  });
});
