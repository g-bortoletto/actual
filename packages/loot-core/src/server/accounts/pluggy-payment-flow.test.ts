import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { runHandler } from '#server/mutators';
import { app as transactionsApp } from '#server/transactions/app';
import { loadRules } from '#server/transactions/transaction-rules';

import { app as accountsApp } from './app';
import type { PluggySyncRow } from './pluggy-sync-review';
import { processBankSyncDownload } from './sync';
import { getEventMappings, getReviewItems } from './sync-observations';

// End-to-end tests for the full Pluggy payment flow (PLAN.md acceptance 2, 3,
// 5 and 7): a real download goes through staging and the review queue, the
// user's decision is materialized, and the payment counterparts are linked —
// with row counts and balances verified at every step.

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

function bankRow(
  transactionId: string,
  date: string,
  amountCents: number,
): PluggySyncRow {
  return {
    transactionId,
    date,
    payeeName: 'Pagamento de fatura',
    notes: 'Pagamento de fatura',
    booked: true,
    status: 'POSTED',
    transactionAmount: { amount: amountCents / 100, currency: 'BRL' },
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
  return db.all<{
    id: string;
    amount: number;
    imported_id: string | null;
    transfer_id: string | null;
  }>(
    `SELECT id, amount, imported_id, transfer_id
       FROM v_transactions_internal
      WHERE account = ? AND tombstone = 0
      ORDER BY id`,
    [account],
  );
}

const pluggyAcct = { account_sync_source: 'pluggyai', offbudget: 0 };

async function decideAndApply(
  reviewItemId: string,
  action: 'confirm-single-payment' | 'confirm-separate-payments',
) {
  await runHandler(accountsApp.handlers['bank-sync-review-decide'], {
    reviewItemId,
    action,
  });
  return runHandler(accountsApp.handlers['bank-sync-review-apply'], {
    reviewItemId,
  });
}

describe('Pluggy payment end-to-end', () => {
  test('one payment with two card representations: held, reviewed, imported once, then linked', async () => {
    await setupAccounts();

    // Bank side: the debit imports normally.
    await processBankSyncDownload(
      {
        startingBalance: -10000,
        transactions: [bankRow('bank-payment-001', '2026-09-25', -10000)],
      },
      'bank',
      pluggyAcct,
    );
    expect(await aliveTransactions('bank')).toHaveLength(1);

    // Card side: the two representations of the same payment arrive together.
    const twinA = cardRow('card-twin-a', '2026-09-25', 10000, {
      status: 'POSTED',
      'creditCardMetadata.billId': 'closed-bill-A',
    });
    const twinB = cardRow('card-twin-b', '2026-09-25', 10000, {
      status: 'PENDING',
      booked: false,
      'creditCardMetadata.billId': 'open-forecast-B',
    });

    await processBankSyncDownload(
      { startingBalance: 10000, transactions: [twinA, twinB] },
      'card',
      pluggyAcct,
    );

    // Nothing reaches the card ledger while the group is held.
    expect(await aliveTransactions('card')).toHaveLength(0);
    const items = await getReviewItems('card');
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('pending');
    expect(items[0].observationIds).toEqual([
      'card:card-twin-a',
      'card:card-twin-b',
    ]);

    // Re-syncing the same snapshot changes nothing (acceptance 1).
    await processBankSyncDownload(
      { startingBalance: 10000, transactions: [twinA, twinB] },
      'card',
      pluggyAcct,
    );
    expect(await getReviewItems('card')).toHaveLength(1);
    expect(await aliveTransactions('card')).toHaveLength(0);

    // The user confirms one payment; applying imports it exactly once.
    const applyResult = await decideAndApply(
      items[0].id,
      'confirm-single-payment',
    );
    expect(applyResult.status).toBe('applied');

    const credits = await aliveTransactions('card');
    expect(credits).toHaveLength(1);
    expect(credits[0].amount).toBe(10000);
    // The posted representation wins over the pending one.
    expect(credits[0].imported_id).toBe('card-twin-a');

    // Link the counterparts: exactly two rows, balances unchanged (acceptance 7).
    const bankTx = (await aliveTransactions('bank'))[0];
    const linkResult = await runHandler(
      transactionsApp.handlers['transactions-link-transfer'],
      { fromId: bankTx.id, toId: credits[0].id },
    );
    expect(linkResult.status).toBe('linked');

    const bankAfter = await aliveTransactions('bank');
    const cardAfter = await aliveTransactions('card');
    expect(bankAfter).toHaveLength(1);
    expect(cardAfter).toHaveLength(1);
    expect(bankAfter[0].transfer_id).toBe(cardAfter[0].id);
    expect(cardAfter[0].transfer_id).toBe(bankAfter[0].id);
    expect(bankAfter[0].amount).toBe(-10000);
    expect(cardAfter[0].amount).toBe(10000);
    expect(bankAfter[0].amount + cardAfter[0].amount).toBe(0);

    // The suppressed alias still does not return (acceptance 5).
    await processBankSyncDownload(
      { startingBalance: 10000, transactions: [twinA, twinB] },
      'card',
      pluggyAcct,
    );
    expect(await aliveTransactions('card')).toHaveLength(1);
    expect(await getReviewItems('card')).toHaveLength(1);
  });

  test('two legitimate equal-value payments: held as ambiguous, then confirmed separate', async () => {
    await setupAccounts();

    const first = cardRow('equal-a', '2026-09-25', 10000, {
      status: 'POSTED',
    });
    const second = cardRow('equal-b', '2026-09-25', 10000, {
      status: 'POSTED',
    });

    await processBankSyncDownload(
      { startingBalance: 20000, transactions: [first, second] },
      'card',
      pluggyAcct,
    );

    // Equal same-day credits are ambiguous: held, never silently merged.
    expect(await aliveTransactions('card')).toHaveLength(0);
    const items = await getReviewItems('card');
    expect(items).toHaveLength(1);

    // The user confirms they are separate payments; both import.
    const applyResult = await decideAndApply(
      items[0].id,
      'confirm-separate-payments',
    );
    expect(applyResult.status).toBe('applied');

    const credits = await aliveTransactions('card');
    expect(credits).toHaveLength(2);
    expect(credits.reduce((sum, row) => sum + row.amount, 0)).toBe(20000);
    expect(new Set(credits.map(row => row.imported_id))).toEqual(
      new Set(['equal-a', 'equal-b']),
    );

    const mappings = await getEventMappings('card');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].aliasObservationIds).toEqual([]);
  });
});
