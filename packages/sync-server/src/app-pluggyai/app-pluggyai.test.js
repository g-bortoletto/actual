import { describe, expect, it } from 'vitest';

import { preparePluggyTransaction } from './app-pluggyai';

const date = value => new Date(`${value}T00:00:00.000Z`);

const baseTransaction = (overrides = {}) => ({
  id: 'txn-1',
  accountId: 'acct-1',
  date: date('2026-09-28'),
  description: 'Mercadolivre*Mercadol 2/10',
  descriptionRaw: null,
  type: 'DEBIT',
  amount: 459.99,
  amountInAccountCurrency: null,
  currencyCode: 'BRL',
  status: 'POSTED',
  ...overrides,
});

describe('preparePluggyTransaction', () => {
  it('keeps the provider posting date on installment rows instead of recomputing it', () => {
    const trans = baseTransaction({
      creditCardMetadata: {
        installmentNumber: 2,
        totalInstallments: 10,
        // A live row reported this as the "purchase date" even though the
        // series started the month before; the provider date is the only
        // reliable ledger date.
        purchaseDate: date('2026-09-27'),
      },
    });

    const result = preparePluggyTransaction(trans, {
      accountType: 'CREDIT',
      startDate: '2026-08-01',
    });

    expect(result.date).toBe('2026-09-28');
    // The old behavior recomputed purchaseDate + (installmentNumber - 1)
    // months and would have stored 2026-10-27 here.
    expect(result.date).not.toBe('2026-10-27');
    expect(result.originalDate).toBe('2026-09-28');
    expect(result['creditCardMetadata.installmentNumber']).toBe(2);
    expect(result['creditCardMetadata.totalInstallments']).toBe(10);
    // purchaseDate stays as evidence, as a plain calendar date.
    expect(result['creditCardMetadata.purchaseDate']).toBe('2026-09-27');
  });

  it('keeps the posting date for the first installment even when purchaseDate differs', () => {
    const trans = baseTransaction({
      date: date('2026-01-06'),
      creditCardMetadata: {
        installmentNumber: 1,
        totalInstallments: 1,
        purchaseDate: date('2025-12-30'),
      },
    });

    const result = preparePluggyTransaction(trans, {
      accountType: 'CREDIT',
      startDate: '2025-08-01',
    });

    // The old behavior replaced the posted date with the purchase date here.
    expect(result.date).toBe('2026-01-06');
  });

  it('keeps the posting date when there is no installment metadata', () => {
    const result = preparePluggyTransaction(baseTransaction(), {
      accountType: 'CREDIT',
      startDate: '2026-08-01',
    });

    expect(result.date).toBe('2026-09-28');
  });

  it('flips credit card signs once: purchases negative, payments positive', () => {
    const purchase = preparePluggyTransaction(
      baseTransaction({ amount: 100 }),
      {
        accountType: 'CREDIT',
        startDate: '2026-08-01',
      },
    );
    const payment = preparePluggyTransaction(
      baseTransaction({ amount: -100, type: 'CREDIT' }),
      { accountType: 'CREDIT', startDate: '2026-08-01' },
    );

    expect(purchase.transactionAmount.amount).toBe(-100);
    expect(payment.transactionAmount.amount).toBe(100);
  });

  it('keeps bank account signs unchanged', () => {
    const expense = preparePluggyTransaction(
      baseTransaction({ amount: -100 }),
      { accountType: 'BANK', startDate: '2026-08-01' },
    );

    expect(expense.transactionAmount.amount).toBe(-100);
  });

  it('prefers amountInAccountCurrency for the converted amount', () => {
    const trans = baseTransaction({
      amount: 33.62,
      amountInAccountCurrency: 174.13,
      currencyCode: 'USD',
    });

    const result = preparePluggyTransaction(trans, {
      accountType: 'CREDIT',
      startDate: '2026-08-01',
    });

    expect(result.transactionAmount.amount).toBe(-174.13);
    expect(result.transactionAmount.currency).toBe('USD');
  });

  it('marks pending rows as not booked', () => {
    const result = preparePluggyTransaction(
      baseTransaction({ status: 'PENDING' }),
      { accountType: 'CREDIT', startDate: '2026-08-01' },
    );

    expect(result.booked).toBe(false);
    expect(result.cleared).toBeUndefined();
  });

  it('carries the source identity through unchanged', () => {
    const result = preparePluggyTransaction(baseTransaction(), {
      accountType: 'CREDIT',
      startDate: '2026-08-01',
    });

    expect(result.transactionId).toBe('txn-1');
    expect(result.sortOrder).toBe(date('2026-09-28').getTime());
    expect(result.notes).toBe('Mercadolivre*Mercadol 2/10');
  });

  it('returns null for empty transaction rows', () => {
    expect(
      preparePluggyTransaction(
        {},
        { accountType: 'CREDIT', startDate: '2026-08-01' },
      ),
    ).toBeNull();
  });
});
