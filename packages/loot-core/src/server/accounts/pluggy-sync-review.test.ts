import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { loadRules } from '#server/transactions/transaction-rules';

import { app as accountsApp } from './app';
import {
  findDuplicatePaymentGroups,
  reviewPluggySync,
} from './pluggy-sync-review';
import type { PluggySyncRow } from './pluggy-sync-review';
import { processBankSyncDownload } from './sync';
import {
  createReviewItem,
  getAccountUncertainty,
  getDecisions,
  getReviewItems,
  updateReviewItemState,
} from './sync-observations';
import type { ReviewEvidence } from './sync-observations';

// Synthetic tests for the duplicate-payment review pipeline (PLAN.md step 2):
// detection of ambiguous card-credit groups, staging, holding, and the wiring
// through `processBankSyncDownload`.

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
      ORDER BY date DESC, id`,
    [account],
  );
}

describe('findDuplicatePaymentGroups', () => {
  test('groups equal positive card credits on the same day', () => {
    const rows = [
      cardRow('a', '2026-09-25', 10000),
      cardRow('b', '2026-09-25', 10000),
    ];

    expect(findDuplicatePaymentGroups(rows)).toEqual([
      { indexes: [0, 1], amountCents: 10000 },
    ]);
  });

  test('groups dates within one day of each other', () => {
    const rows = [
      cardRow('a', '2026-09-25', 10000),
      cardRow('b', '2026-09-26', 10000),
    ];

    expect(findDuplicatePaymentGroups(rows)).toHaveLength(1);
  });

  test('does not group equal amounts further apart than one day', () => {
    const rows = [
      cardRow('a', '2026-09-25', 10000),
      cardRow('b', '2026-09-27', 10000),
    ];

    expect(findDuplicatePaymentGroups(rows)).toEqual([]);
  });

  test('does not group different amounts', () => {
    const rows = [
      cardRow('a', '2026-09-25', 10000),
      cardRow('b', '2026-09-25', 20000),
    ];

    expect(findDuplicatePaymentGroups(rows)).toEqual([]);
  });

  test('ignores purchases and rows without card metadata', () => {
    const rows = [
      cardRow('purchase', '2026-09-25', -10000),
      // A bank deposit: no credit-card metadata at all.
      {
        transactionId: 'deposit',
        date: '2026-09-25',
        transactionAmount: { amount: 100, currency: 'BRL' },
      },
    ];

    expect(findDuplicatePaymentGroups(rows)).toEqual([]);
  });

  test('finds two groups in the two-debits/four-credits constellation', () => {
    const rows = [
      cardRow('a1', '2026-09-25', 10000),
      cardRow('a2', '2026-09-25', 10000),
      cardRow('b1', '2026-09-25', 25673),
      cardRow('b2', '2026-09-25', 25673),
    ];

    const groups = findDuplicatePaymentGroups(rows);
    expect(groups).toHaveLength(2);
    expect(
      groups.map(group => group.amountCents).sort((x, y) => x - y),
    ).toEqual([10000, 25673]);
  });

  test('chains adjacent days into one group of three', () => {
    const rows = [
      cardRow('a', '2026-09-25', 10000),
      cardRow('b', '2026-09-26', 10000),
      cardRow('c', '2026-09-27', 10000),
    ];

    expect(findDuplicatePaymentGroups(rows)).toHaveLength(1);
    expect(findDuplicatePaymentGroups(rows)[0].indexes).toEqual([0, 1, 2]);
  });
});

describe('reviewPluggySync', () => {
  test('stages every observation and holds ambiguous card credits', async () => {
    await setupAccounts();
    const rows = [
      cardRow('purchase', '2026-09-20', -5000),
      cardRow('twin-a', '2026-09-25', 10000, {
        'creditCardMetadata.billId': 'closed-bill-A',
      }),
      cardRow('twin-b', '2026-09-25', 10000, {
        'creditCardMetadata.cardNumber': '****1234',
      }),
    ];

    const result = await reviewPluggySync('card', rows);

    expect([...result.heldTransactionIds].sort()).toEqual(['twin-a', 'twin-b']);
    expect(result.reviewItemIds).toHaveLength(1);

    const staged = await db.all<{ id: string }>(
      'SELECT id FROM bank_sync_observations ORDER BY id',
    );
    expect(staged).toHaveLength(3);

    const items = await getReviewItems('card');
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('ambiguous-payment');
    expect(items[0].state).toBe('pending');
    expect(items[0].evidence?.heldAmountCents).toBe(20000);
    expect(items[0].evidence?.minScenarioAmountCents).toBe(10000);
    expect(items[0].evidence?.observations).toHaveLength(2);
  });

  test('includes ledger counterparts as candidate evidence', async () => {
    await setupAccounts();
    await db.insertTransaction({
      account: 'bank',
      amount: -10000,
      date: '2026-09-25',
    });

    await reviewPluggySync('card', [
      cardRow('twin-a', '2026-09-25', 10000),
      cardRow('twin-b', '2026-09-25', 10000),
    ]);

    const items = await getReviewItems('card');
    expect(items[0].evidence?.candidates).toHaveLength(1);
    expect(items[0].evidence?.candidates?.[0].amountCents).toBe(-10000);
    expect(items[0].evidence?.candidates?.[0].date).toBe('2026-09-25');
  });

  test('is idempotent: a repeated snapshot neither re-queues nor re-holds less', async () => {
    await setupAccounts();
    const rows = [
      cardRow('twin-a', '2026-09-25', 10000),
      cardRow('twin-b', '2026-09-25', 10000),
    ];

    const first = await reviewPluggySync('card', rows);
    const second = await reviewPluggySync('card', rows);

    expect(first.reviewItemIds).toHaveLength(1);
    expect(second.reviewItemIds).toHaveLength(0);
    expect([...second.heldTransactionIds].sort()).toEqual(['twin-a', 'twin-b']);
    expect(await getReviewItems('card')).toHaveLength(1);
    expect(await getAccountUncertainty('card')).toEqual({
      pendingCount: 1,
      heldAmountCents: 20000,
    });
  });
});

describe('processBankSyncDownload with Pluggy review', () => {
  test('holds ambiguous card credits out of the ledger, keeps the rest', async () => {
    await setupAccounts();
    const download = {
      startingBalance: -5000,
      transactions: [
        cardRow('purchase', '2026-09-20', -5000),
        cardRow('twin-a', '2026-09-25', 10000),
        cardRow('twin-b', '2026-09-25', 10000),
      ],
    };
    const acctRow = { account_sync_source: 'pluggyai', offbudget: 0 };

    await processBankSyncDownload(download, 'card', acctRow);

    const ledger = await aliveTransactions('card');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].imported_id).toBe('purchase');
    expect(ledger[0].amount).toBe(-5000);

    expect(await getReviewItems('card')).toHaveLength(1);

    // Re-running the same snapshot must not change the ledger or the queue.
    await processBankSyncDownload(download, 'card', acctRow);
    expect(await aliveTransactions('card')).toHaveLength(1);
    expect(await getReviewItems('card')).toHaveLength(1);
  });

  test('excludes held rows from the initial-sync opening balance math', async () => {
    await setupAccounts();
    await db.insertAccount({ id: 'card2', name: 'Credit Card 2' });
    await db.insertPayee({
      id: 'transfer-card2',
      name: '',
      transfer_acct: 'card2',
    });

    const download = {
      startingBalance: 0,
      transactions: [
        cardRow('twin-a', '2026-09-25', 10000),
        cardRow('twin-b', '2026-09-25', 10000),
        cardRow('purchase', '2026-09-20', -5000),
      ],
    };
    const acctRow = { account_sync_source: 'pluggyai', offbudget: 0 };

    await processBankSyncDownload(download, 'card2', acctRow, true);

    const ledger = await aliveTransactions('card2');
    expect(ledger).toHaveLength(2);
    const starting = ledger.find(row => row.imported_id == null);
    expect(starting?.amount).toBe(5000);
    expect(ledger.some(row => row.imported_id === 'twin-a')).toBe(false);
    expect(ledger.some(row => row.imported_id === 'twin-b')).toBe(false);

    expect(await getReviewItems('card2')).toHaveLength(1);
  });
});

describe('bank-sync-review-decide handler', () => {
  const decide = accountsApp.handlers['bank-sync-review-decide'];

  const reviewEvidence: ReviewEvidence = {
    observations: [
      {
        observationId: 'card:a',
        date: '2026-09-25',
        amountCents: 10000,
        description: 'Pagamento recebido',
      },
    ],
    heldAmountCents: 20000,
    minScenarioAmountCents: 10000,
  };

  test('records the decision and moves the item out of pending', async () => {
    await setupAccounts();
    const itemId = await createReviewItem(
      'card',
      'ambiguous-payment',
      ['card:a', 'card:b'],
      reviewEvidence,
    );

    const result = await decide({
      reviewItemId: itemId,
      action: 'confirm-single-payment',
    });

    expect(result.state).toBe('confirmed-single-payment');

    const items = await getReviewItems('card');
    expect(items[0].state).toBe('confirmed-single-payment');

    const decisions = await getDecisions(itemId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('confirm-single-payment');
    // Recording a decision must not claim it was applied to the ledger.
    expect(decisions[0].appliedAt).toBeNull();
  });

  test('rejects unknown review items', async () => {
    await expect(
      decide({ reviewItemId: 'missing', action: 'leave-unresolved' }),
    ).rejects.toThrow('Review item not found');
  });

  test('refuses to change an applied item', async () => {
    await setupAccounts();
    const itemId = await createReviewItem(
      'card',
      'ambiguous-payment',
      ['card:a'],
      reviewEvidence,
    );
    await updateReviewItemState(itemId, 'applied');

    await expect(
      decide({ reviewItemId: itemId, action: 'leave-unresolved' }),
    ).rejects.toThrow('already been applied');
  });
});
