import * as db from '#server/db';
import { runHandler } from '#server/mutators';

import { app } from './app';

// Tests for the validated transfer-linking operation (PLAN.md step 3): the
// server-side counterpart of the client's "Make transfer" action. Linking two
// existing records must set reciprocal transfer payees and pointers, preserve
// amounts, dates, notes and source ids, create no rows, and be idempotent.

const { emptyDatabase } = global as typeof globalThis & {
  emptyDatabase: () => () => Promise<void>;
};

beforeEach(async () => {
  await emptyDatabase()();
});

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

type TxInput = {
  account: string;
  amount: number;
  date?: string;
  payee?: string;
  category?: string;
  notes?: string;
  imported_id?: string;
  is_parent?: boolean;
};

function insertTx(input: TxInput) {
  return db.insertTransaction({
    date: '2026-09-25',
    ...input,
  });
}

function rowOf(id: string) {
  return db.first<{
    id: string;
    account: string;
    amount: number;
    // The raw view stores dates as integer YYYYMMDD.
    date: number;
    payee: string | null;
    transfer_id: string | null;
    category: string | null;
    imported_id: string | null;
    notes: string | null;
  }>(
    `SELECT id, account, amount, date, payee, transfer_id, category, imported_id, notes
       FROM v_transactions_internal
      WHERE id = ?`,
    [id],
  );
}

async function accountTotal(account: string) {
  const row = await db.first<{ total: number | null }>(
    `SELECT SUM(amount) AS total
       FROM v_transactions_internal
      WHERE account = ? AND tombstone = 0`,
    [account],
  );
  return row?.total ?? 0;
}

async function transactionCount() {
  const row = await db.first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM v_transactions_internal WHERE tombstone = 0',
  );
  return row?.count ?? 0;
}

const linkTransferHandler = app.handlers['transactions-link-transfer'];
const callLink = (args: { fromId: string; toId: string; dryRun?: boolean }) =>
  runHandler(linkTransferHandler, args);

async function insertCounterparts() {
  const bankPayee = await db.insertPayee({ name: 'Pagamento de fatura' });
  const cardPayee = await db.insertPayee({ name: 'Pagamento recebido' });

  const bankId = await insertTx({
    account: 'bank',
    amount: -10000,
    payee: bankPayee,
    imported_id: 'bank-payment-001',
    notes: 'Pagamento de fatura',
  });
  const cardId = await insertTx({
    account: 'card',
    amount: 10000,
    payee: cardPayee,
    imported_id: 'card-payment-001',
  });

  return { bankId, cardId };
}

describe('linkTransfer', () => {
  test('links two imported counterparts without changing amounts, dates, evidence, or row counts', async () => {
    await setupAccounts();
    await db.insertCategoryGroup({
      id: 'group1',
      name: 'group1',
      is_income: 0,
    });
    const categoryId = await db.insertCategory({
      id: 'cat1',
      name: 'cat1',
      cat_group: 'group1',
      is_income: 0,
    });

    const bankPayee = await db.insertPayee({ name: 'Pagamento de fatura' });
    const cardPayee = await db.insertPayee({ name: 'Pagamento recebido' });
    const bankId = await insertTx({
      account: 'bank',
      amount: -10000,
      payee: bankPayee,
      category: categoryId,
      imported_id: 'bank-payment-001',
      notes: 'Pagamento de fatura',
    });
    const cardId = await insertTx({
      account: 'card',
      amount: 10000,
      payee: cardPayee,
      imported_id: 'card-payment-001',
    });

    const before = {
      count: await transactionCount(),
      bank: await accountTotal('bank'),
      card: await accountTotal('card'),
    };

    const result = await callLink({ fromId: bankId, toId: cardId });

    expect(result.status).toBe('linked');

    const bank = await rowOf(bankId);
    const card = await rowOf(cardId);

    // Reciprocal pointers and transfer payees.
    expect(bank?.transfer_id).toBe(cardId);
    expect(card?.transfer_id).toBe(bankId);
    expect(bank?.payee).toBe('transfer-card');
    expect(card?.payee).toBe('transfer-bank');
    expect(bank?.category).toBeNull();
    expect(card?.category).toBeNull();

    // Everything else preserved.
    expect(bank?.amount).toBe(-10000);
    expect(card?.amount).toBe(10000);
    expect(bank?.date).toBe(20260925);
    expect(card?.date).toBe(20260925);
    expect(bank?.imported_id).toBe('bank-payment-001');
    expect(card?.imported_id).toBe('card-payment-001');
    expect(bank?.notes).toBe('Pagamento de fatura');

    // No rows created, no balances moved.
    expect(await transactionCount()).toBe(before.count);
    expect(await accountTotal('bank')).toBe(before.bank);
    expect(await accountTotal('card')).toBe(before.card);
  });

  test('is idempotent: linking an already-linked pair changes nothing', async () => {
    await setupAccounts();
    const { bankId, cardId } = await insertCounterparts();

    await callLink({ fromId: bankId, toId: cardId });
    const snapshot = {
      count: await transactionCount(),
      bank: await rowOf(bankId),
      card: await rowOf(cardId),
    };

    const second = await callLink({ fromId: bankId, toId: cardId });

    expect(second.status).toBe('already-linked');
    expect(second.changes).toEqual([]);
    expect(await transactionCount()).toBe(snapshot.count);
    expect(await rowOf(bankId)).toEqual(snapshot.bank);
    expect(await rowOf(cardId)).toEqual(snapshot.card);
  });

  test('dry-run reports the plan without writing anything', async () => {
    await setupAccounts();
    const { bankId, cardId } = await insertCounterparts();

    const result = await callLink({
      fromId: bankId,
      toId: cardId,
      dryRun: true,
    });

    expect(result.status).toBe('planned');
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map(change => change.id).sort()).toEqual(
      [bankId, cardId].sort(),
    );

    const bank = await rowOf(bankId);
    const card = await rowOf(cardId);
    expect(bank?.transfer_id).toBeNull();
    expect(card?.transfer_id).toBeNull();
  });

  test('refuses to link two transactions from the same account', async () => {
    await setupAccounts();
    const a = await insertTx({ account: 'bank', amount: -10000 });
    const b = await insertTx({ account: 'bank', amount: 10000 });

    await expect(callLink({ fromId: a, toId: b })).rejects.toThrow(
      'same account',
    );
  });

  test('refuses to link non-opposite amounts', async () => {
    await setupAccounts();
    const a = await insertTx({ account: 'bank', amount: -10000 });
    const b = await insertTx({ account: 'card', amount: 9000 });

    await expect(callLink({ fromId: a, toId: b })).rejects.toThrow(
      'exact opposites',
    );
  });

  test('refuses when one side is already linked to a different transfer', async () => {
    await setupAccounts();
    const { bankId, cardId } = await insertCounterparts();
    const other = await insertTx({ account: 'card', amount: 10000 });

    await callLink({ fromId: bankId, toId: cardId });

    await expect(callLink({ fromId: bankId, toId: other })).rejects.toThrow(
      'already linked',
    );
  });

  test('refuses to link split transactions', async () => {
    await setupAccounts();
    const parent = await insertTx({
      account: 'bank',
      amount: -10000,
      is_parent: true,
    });
    const card = await insertTx({ account: 'card', amount: 10000 });

    await expect(callLink({ fromId: parent, toId: card })).rejects.toThrow(
      'Split transactions',
    );
  });

  test('refuses to link a missing transaction', async () => {
    await setupAccounts();
    const card = await insertTx({ account: 'card', amount: 10000 });

    await expect(callLink({ fromId: 'missing', toId: card })).rejects.toThrow(
      'Transaction not found',
    );
  });

  test('refuses to link when an account has no transfer payee', async () => {
    await setupAccounts();
    await db.insertAccount({ id: 'bare', name: 'No transfer payee' });
    const bank = await insertTx({ account: 'bank', amount: -10000 });
    const bare = await insertTx({ account: 'bare', amount: 10000 });

    await expect(callLink({ fromId: bank, toId: bare })).rejects.toThrow(
      'no transfer payee',
    );
  });
});
