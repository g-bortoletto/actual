import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';

import { reconcileTransactions } from './sync';

// Synthetic regression tests for PLAN.md (Reliable Pluggy -> Actual Budget
// Synchronization), step 1.
//
// These tests exercise the importer with the synthetic fixture from PLAN.md
// ("Synthetic fixture to start with"): a bank debit of 10,000 cents and two
// card-side observations of the same payment, each with its own source id.
//
// Amounts here are integer cents in the fixture but the loot-core bank-sync
// pipeline consumes decimal currency units and converts with
// `amountToInteger` (see `reconcileTransactions`), so this file converts once
// at the boundary: `amountCents / 100`.
//
// Status of the tests:
// - Tests marked `KNOWN ISSUE` / `KNOWN TRAP` characterize the behavior of
//   `reconcileTransactions` called directly, bypassing the review pipeline.
//   The pipeline-level behavior (staging, holding, decisions, materialization)
//   is covered end-to-end in `pluggy-payment-flow.test.ts`.
// - The former `it.fails` markers for acceptance test 2 were replaced by the
//   end-to-end flow tests once the review pipeline landed.

const BRL = 'BRL';

const BANK_MOVEMENT = {
  sourceId: 'bank-payment-001',
  date: '2026-09-25',
  amountCents: -10000,
  payeeName: 'Pagamento de fatura',
  status: 'POSTED',
} as const;

// Variant A (per PLAN.md): debit payment method, bill id present, no card
// number metadata.
const CARD_OBSERVATION_A = {
  sourceId: 'card-payment-debit-001',
  date: '2026-09-25',
  amountCents: 10000,
  payeeName: 'João Silva',
  status: 'POSTED',
  billReference: 'closed-bill-A',
} as const;

// Variant B (per PLAN.md): no payment method, card-number metadata present,
// may belong to another bill / open forecast period. PLAN.md asks to test it
// both as PENDING and as POSTED.
const CARD_OBSERVATION_B = {
  sourceId: 'card-payment-other-001',
  date: '2026-09-25',
  amountCents: 10000,
  payeeName: 'Pagamento recebido',
  status: 'PENDING',
  billReference: 'open-forecast-B',
} as const;

type BankSyncRow = {
  date: string;
  payeeName: string;
  transactionAmount: { amount: number; currency: string };
  transactionId: string;
  booked: boolean;
};

type Observation = {
  sourceId: string;
  date: string;
  amountCents: number;
  payeeName: string;
  status: string;
  billReference?: string;
};

// Mirrors the shape `normalizeBankSyncTransactions` consumes from a bank-sync
// provider such as the Pluggy adapter (see
// packages/sync-server/src/app-pluggyai/app-pluggyai.js). Note: the bill label
// (`billReference`) carried by the live feed is NOT part of this shape today —
// the current importer cannot see bill assignments at all (see
// PLUGGY_SYNC_RCA.md §2.1). Canonicalization therefore needs a layer with
// richer source data, not only the normalized bank-sync rows.
function toBankSyncRow(observation: Observation): BankSyncRow {
  return {
    date: observation.date,
    payeeName: observation.payeeName,
    transactionAmount: {
      amount: observation.amountCents / 100,
      currency: BRL,
    },
    transactionId: observation.sourceId,
    booked: observation.status !== 'PENDING',
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

// The options used by `processBankSyncDownload` for a Pluggy account:
// `isBankSyncAccount: true` and `strictIdChecking: false` (derived from
// `account_sync_source` being set).
const BANK_SYNC_OPTIONS = {
  isBankSyncAccount: true,
  strictIdChecking: false,
} as const;

async function importBankMovement() {
  await reconcileTransactions('bank', [toBankSyncRow(BANK_MOVEMENT)], {
    ...BANK_SYNC_OPTIONS,
  });
}

async function importCardObservations(
  statusB: 'POSTED' | 'PENDING' = 'PENDING',
) {
  await reconcileTransactions(
    'card',
    [
      toBankSyncRow(CARD_OBSERVATION_A),
      toBankSyncRow({ ...CARD_OBSERVATION_B, status: statusB }),
    ],
    { ...BANK_SYNC_OPTIONS },
  );
}

async function importFixture(statusB: 'POSTED' | 'PENDING' = 'PENDING') {
  await importBankMovement();
  await importCardObservations(statusB);
}

type Row = {
  id: string;
  amount: number;
  date: number | string;
  imported_id: string | null;
  cleared: number | boolean;
  transfer_id: string | null;
  tombstone: number | boolean;
};

function aliveTransactions(account: string) {
  return db.all<Row>(
    `SELECT id, amount, date, imported_id, cleared, transfer_id, tombstone
       FROM v_transactions_internal
      WHERE account = ? AND tombstone = 0
      ORDER BY date DESC, id`,
    [account],
  );
}

async function cardCredits() {
  return aliveTransactions('card');
}

async function bankDebits() {
  return aliveTransactions('bank');
}

function totalCents(rows: Array<Pick<Row, 'amount'>>) {
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
});

describe('Pluggy card payment representations (PLAN.md synthetic fixture)', () => {
  test('characterization: calling reconcileTransactions directly (bypassing the review pipeline) imports both credits', async () => {
    await setupAccounts();
    await importFixture();

    const credits = await cardCredits();

    // `reconcileTransactions` on its own still sees two card credits of
    // 10,000 cents each for a single 10,000 cent payment. The review pipeline
    // (`processBankSyncDownload` → staging/hold → decision → materialization)
    // is what prevents this from reaching a real sync; see
    // `pluggy-payment-flow.test.ts` for the end-to-end behavior.
    expect(credits).toHaveLength(2);
    expect(totalCents(credits)).toBe(20000);

    expect(credits.map(row => row.imported_id).sort()).toEqual([
      'card-payment-debit-001',
      'card-payment-other-001',
    ]);

    // The bank side is imported exactly once.
    const debits = await bankDebits();
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(-10000);
  });

  test('control (acceptance 3): two legitimate equal-value payments are not merged or suppressed', async () => {
    await setupAccounts();

    // Two genuine payments of 10,000 cents each. One carries "Variant A"-like
    // metadata and the other "Variant B"-like metadata, so that no future
    // canonicalization rule may key off the metadata pattern alone.
    const firstPayment = {
      bank: {
        ...BANK_MOVEMENT,
        sourceId: 'bank-payment-002',
        date: '2026-08-10',
      },
      card: {
        ...CARD_OBSERVATION_A,
        sourceId: 'card-payment-debit-002',
        date: '2026-08-10',
      },
    };
    const secondPayment = {
      bank: {
        ...BANK_MOVEMENT,
        sourceId: 'bank-payment-003',
        date: '2026-09-25',
      },
      card: {
        ...CARD_OBSERVATION_B,
        sourceId: 'card-payment-other-002',
        date: '2026-09-25',
        status: 'POSTED',
      },
    };

    await reconcileTransactions(
      'bank',
      [toBankSyncRow(firstPayment.bank), toBankSyncRow(secondPayment.bank)],
      { ...BANK_SYNC_OPTIONS },
    );
    await reconcileTransactions(
      'card',
      [toBankSyncRow(firstPayment.card), toBankSyncRow(secondPayment.card)],
      { ...BANK_SYNC_OPTIONS },
    );

    const credits = await cardCredits();
    const debits = await bankDebits();

    expect(credits).toHaveLength(2);
    expect(totalCents(credits)).toBe(20000);
    expect(debits).toHaveLength(2);
    expect(totalCents(debits)).toBe(-20000);
  });

  test('control (acceptance 3, same-day ambiguity): identical equal-value payments are both retained', async () => {
    await setupAccounts();

    // Two real payments of the same amount on the same day with different
    // source ids. Matching cannot be proven from the card side alone; the
    // design must keep both and flag the ambiguity rather than merge.
    const twinA = {
      ...CARD_OBSERVATION_A,
      sourceId: 'card-payment-twin-a',
    };
    const twinB = {
      ...CARD_OBSERVATION_B,
      sourceId: 'card-payment-twin-b',
      status: 'POSTED',
    };

    // Fresh import: neither payment has ever been seen, so both must land
    // as independent rows even though date, amount and account match.
    await reconcileTransactions(
      'card',
      [toBankSyncRow(twinA), toBankSyncRow(twinB)],
      { ...BANK_SYNC_OPTIONS },
    );

    const credits = await cardCredits();
    expect(credits).toHaveLength(2);
    expect(totalCents(credits)).toBe(20000);
  });

  test('control (acceptance 3, ambiguous constellation): two debits + four credits are never silently merged', async () => {
    await setupAccounts();

    // The live feed reproduces each payment as TWO card credits differing only
    // by bill label (see PLUGGY_SYNC_RCA.md §2.1). Two genuine same-day
    // payments therefore arrive as two bank debits and four card credits with
    // identical dates and amounts. Pairing cannot be proven from these fields;
    // the system must keep the observations and surface a review signal rather
    // than guess which credit belongs to which debit.
    const debits = [
      { ...BANK_MOVEMENT, sourceId: 'bank-ambiguous-001' },
      { ...BANK_MOVEMENT, sourceId: 'bank-ambiguous-002' },
    ];
    const credits = [
      { ...CARD_OBSERVATION_A, sourceId: 'card-ambiguous-a1' },
      {
        ...CARD_OBSERVATION_A,
        sourceId: 'card-ambiguous-a2',
        billReference: 'open-forecast-A',
      },
      {
        ...CARD_OBSERVATION_B,
        sourceId: 'card-ambiguous-b1',
        status: 'POSTED',
      },
      {
        ...CARD_OBSERVATION_B,
        sourceId: 'card-ambiguous-b2',
        status: 'POSTED',
        billReference: 'open-forecast-B',
      },
    ];

    await reconcileTransactions('bank', debits.map(toBankSyncRow), {
      ...BANK_SYNC_OPTIONS,
    });
    await reconcileTransactions('card', credits.map(toBankSyncRow), {
      ...BANK_SYNC_OPTIONS,
    });

    // Characterization of today's ledger (which double-counts). The guarantee
    // this test enforces for the fix: nothing below may be collapsed into
    // fewer rows without an approved, evidence-backed decision — ambiguous
    // cases must be flagged, never merged by amount+date heuristics.
    const cardRows = await cardCredits();
    const bankRows = await bankDebits();
    expect(cardRows).toHaveLength(4);
    expect(bankRows).toHaveLength(2);
    expect(totalCents(cardRows)).toBe(40000);
    expect(totalCents(bankRows)).toBe(-20000);
  });

  test('idempotency (acceptance 1): re-importing the same snapshot changes nothing', async () => {
    await setupAccounts();
    await importFixture();

    const firstBank = await bankDebits();
    const firstCard = await cardCredits();

    await importFixture();

    const secondBank = await bankDebits();
    const secondCard = await cardCredits();

    expect(secondBank.map(row => row.id)).toEqual(firstBank.map(row => row.id));
    expect(secondCard.map(row => row.id)).toEqual(firstCard.map(row => row.id));
    expect(totalCents(secondBank)).toBe(-10000);
    expect(totalCents(secondCard)).toBe(20000);
  });

  test('KNOWN ISSUE (PLAN.md problem 2): a deleted credit returns on the next sync with the same source id and a new Actual id', async () => {
    await setupAccounts();
    await importFixture();

    const before = await cardCredits();
    const duplicate = before.find(
      row => row.imported_id === 'card-payment-other-001',
    );
    expect(duplicate).toBeDefined();

    await db.deleteTransaction({ id: duplicate!.id });
    expect(await cardCredits()).toHaveLength(1);

    await importFixture();

    const after = await cardCredits();
    expect(after).toHaveLength(2);
    expect(totalCents(after)).toBe(20000);

    // Same source import id, different Actual internal id: deletion alone is
    // not durable. This is the default behavior of
    // `sync-reimport-deleted-<acctId>` (true) combined with tombstone
    // invisibility in `v_transactions`.
    const reimported = after.find(
      row => row.imported_id === 'card-payment-other-001',
    );
    expect(reimported).toBeDefined();
    expect(reimported!.id).not.toBe(duplicate!.id);
  });

  test('KNOWN TRAP (PLAN.md problem 3): writing transfer_id without a transfer payee deletes the counterpart and leaves the card unlinked', async () => {
    await setupAccounts();
    await importFixture();

    const credit = (await cardCredits()).find(
      row => row.imported_id === 'card-payment-debit-001',
    );
    const [debit] = await bankDebits();
    expect(credit).toBeDefined();
    expect(debit).toBeDefined();

    // This is the exact engine invoked by the `transaction-update` API
    // handler: a "successful" update that sets transfer_id on the card
    // record, leaving its (non-transfer) payee untouched.
    await batchUpdateTransactions({
      updated: [{ id: credit!.id, transfer_id: debit.id }],
    });

    const cardAfter = await db.first<Row>(
      'SELECT transfer_id, tombstone FROM v_transactions_internal WHERE id = ?',
      [credit!.id],
    );
    // The card record remains unlinked ...
    expect(cardAfter?.transfer_id).toBeNull();
    expect(cardAfter?.tombstone).toBe(0);

    // ... and the matching bank debit was deleted by `removeTransfer`
    // (`transfer.onUpdate` sees a `transfer_id` but no transfer payee).
    const bankAfter = await db.all<Row>(
      'SELECT transfer_id, tombstone FROM v_transactions_internal WHERE id = ?',
      [debit.id],
    );
    expect(bankAfter).toHaveLength(1);
    expect(bankAfter[0].tombstone).toBe(1);

    // The bank ledger balance is now higher by the deleted debit amount.
    expect(await bankDebits()).toHaveLength(0);
  });
});
