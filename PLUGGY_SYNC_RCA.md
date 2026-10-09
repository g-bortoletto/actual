# Pluggy → Actual Budget synchronization — Step 1 root-cause report

Status: draft for review · Date: 2026-10-08
Scope: repository code, public Pluggy documentation, synthetic tests, and (with explicit
permission) a read-only pass over the user's statement-history exports.
**No financial data, credentials, budgets, bank connections or Actual records were modified.**

This report is deliverable 1 of `PLAN.md` ("Root-cause report"). It separates:

- **Confirmed** — reproduced in this repository's code and/or tests.
- **Documented** — stated in current Pluggy product documentation.
- **Hypothesis** — plausible, not yet proven; requires live data or external-tool access.

The synthetic regression tests live in
`packages/loot-core/src/server/accounts/pluggy-card-payments.test.ts`
(6 passing characterization/control tests + 2 expected-failure tests for the
post-fix behavior; see §5).

---

## 1. Integration map — what this repository actually contains

There is **one** in-repo Pluggy integration: the native bank-sync path. No MCP
server, no "financial assistant" tooling, and no other Pluggy importer exists in
this repository.

A second, external ingest path exists in the user's finance workspace: a Personal
CFO agent reading a custom read-only Pluggy MCP (see H1). Only the native path
writes the ledger today — the external Actual MCP is restricted to reads plus two
narrow bookkeeping writes — but both consumers see the same provider feed, and
fix placement must account for that (§6).

```
Actual UI / API / scheduler
  └─ accounts-bank-sync handler            packages/loot-core/src/server/accounts/app.ts
       └─ syncAccount()                     packages/loot-core/src/server/accounts/sync.ts
            └─ downloadPluggyAiTransactions()   → HTTP: POST {sync-server}/pluggyai/transactions
                 headers: X-ACTUAL-TOKEN, X-Actual-File-Id
                      └─ sync-server route      packages/sync-server/src/app-pluggyai/app-pluggyai.js
                           └─ Pluggy SDK fetchAllTransactions(accountId, { dateFrom })
                                → balances, startingBalance, transactions.all/booked/pending
            └─ processBankSyncDownload()    → reconcileTransactions({ isBankSyncAccount: true,
                                                                      strictIdChecking: false })
                 └─ matchTransactions()     → normalizeBankSyncTransactions() → runRules()
                      └─ reconcileTransactions() → batchUpdateTransactions()
                           └─ transfer hooks (onInsert / onUpdate / onDelete)
```

Key facts of the native path:

- Transactions are fetched **by date window** (`dateFrom = syncStartDate`), not by
  bill. The adapter returns `transactions.all` (POSTED + PENDING) plus balances.
- Per-account link identity: `accounts.account_id` holds the Pluggy account id and
  `accounts.account_sync_source = 'pluggyai'` (set by `linkPluggyAiAccount`).
- The sync call is a **fetch**, not a refresh-and-wait flow: requesting a Pluggy
  connection refresh and waiting for source synchronization are not modeled in
  this repo.
- The Pluggy **official MCP server** is documentation/dev-portal only (read-only
  docs query + dashboard inspection; source: docs.pluggy.ai/developer-tools/mcp).
  It does not read end-user transactions. So the live "financial assistant" was
  some external integration of the Pluggy product API (and/or of Actual's API) —
  see hypothesis H1.

---

## 2. Root causes per observed problem

### 2.1 Card payments have two source representations (observed problem 1)

**Confirmed: the importer has no concept of "multiple observations, one economic
event".** It is a record-level importer:

- The adapter passes every Pluggy row through with its own `transactionId`
  (= Pluggy `id`).
- `matchTransactions` (`sync.ts`) only knows two things: (a) exact match on
  `imported_id`; (b) fuzzy match on account + amount + ±7 days (two passes:
  same payee first, then first unmatched row).
- On the **first import** both observations are inserted as independent credits,
  because matching runs before any insert and the database has no candidates.
  On subsequent syncs each observation matches **its own** row by `imported_id`,
  so both stay.
- Nothing in the code implements or persists a canonical-event mapping, and the
  Pluggy bill metadata (`creditCardMetadata.billId`, `paymentData`) is never
  read (only carried inside `raw_synced_data` JSON).

**Documented context:** Pluggy's docs state that credit-card amounts use
`+` for charges and `−` for payments, that `PENDING` means "has not yet impacted
the due balance" (open invoice / future installment), and that both a bill's
`payments[]` array and transaction records can describe the same payment. So two
representations of one payment can legitimately exist at the source; the defect
is the missing equivalence layer, **not** merely "duplicates".

**Reproduced:** characterization test
`KNOWN ISSUE (PLAN.md problem 1): both card observations of one payment import as independent credits`
— fixture A (POSTED, DEBIT metadata) + fixture B (PENDING, card-number metadata,
open forecast bill) produce **two card credits of 10,000 cents each** against one
bank debit of 10,000 cents.

**Live-feed confirmation (2026-10-08, read-only).** A bounded read of the live
Pluggy feed through the finance workspace's MCP (bank + card, 2026-08-01 →
2026-10-08) shows the same structure with real data: each of the four payments in
the window has **one bank `Pagamento de fatura` debit** and **two card
`Pagamento recebido` credits** — identical date, identical amount, positive sign —
whose only visible difference is the bill label (`fatura`): one copy references a
closed bill, the other a later or still-open bill (`~YYYY-MM` forecast). The user's
statements show exactly **one** credit per payment (§3.5). Corroborating anomaly:
some live bills show `paid` greater than `total`, consistent with payment
attribution crossing bill boundaries.

Equivalence for these specific events is statement-confirmed, but the twin
structure is a _candidate detector_, not a universal identity rule: bill labels
can represent allocation or forecasting, and a single bank debit is only unique
within declared, sufficiently complete coverage. A universal automatic rule needs
an authoritative equivalence basis (shared payment reference, verified provider
semantics) — see §6.

### 2.2 Deleting duplicates does not prevent reimport (observed problem 2)

**Confirmed mechanism.** Deletion in Actual is a soft delete: `db.deleteTransaction`
sets `tombstone = 1` (`packages/loot-core/src/server/db/index.ts`, `delete_`).
The match query then depends on the preference `sync-reimport-deleted-<acctId>`,
**default `true`**:

- default (`true`): exact-ID lookup runs against `v_transactions`, which
  _excludes tombstones_ → the deleted row is invisible → the next sync inserts a
  **new row with a new Actual id and the same `imported_id`**;
- `false`: lookup runs against `v_transactions_internal` (includes tombstones) →
  the dead row is found, `hasMatched` records it, and no new row is created.

The existing test `reconcile does rematch deleted transactions by default`
(`sync.test.ts`) documents exactly this default, and its snapshot shows the
tombstoned row plus the new row. This reproduces the reported symptom — "new
Actual internal transaction IDs, the same source import IDs" — **without**
requiring Pluggy to have generated new IDs.

Second-order confirmed behavior to handle in the design: for bank-sync accounts
`strictIdChecking = false`, so an observation whose ID no longer matches (e.g.
deleted row, provider delete/recreate, window change) can fuzzy-merge into
**another** same-amount row within ±7 days and, via the update path, overwrite
that row's `imported_id` with its own (`updates.imported_id = trans.imported_id`).
The matched row's amount is never updated on match, and user fields
(payee/category/notes) are only filled if empty. This interacts directly with
PLAN.md acceptance tests 5, 15, 18.

**Reproduced:** characterization test
`KNOWN ISSUE (PLAN.md problem 2): a deleted credit returns on the next sync with the same source id and a new Actual id`.

### 2.3 Existing-record transfer linking was unsafe (observed problem 3)

**Confirmed mechanism, reproduced.** The `transaction-update` handler calls
`batchUpdateTransactions({ updated: [transaction] })`, which runs
`transfer.onUpdate` on every updated row. `onUpdate` derives the transfer
counterpart **only from the payee**: if the payee is not a transfer payee
(`payees.transfer_acct` set) and the row has a `transfer_id`, it calls
`removeTransfer`, which:

1. `deleteTransaction` on the referenced row (the bank debit!), and
2. sets the card row's `transfer_id = null`.

The card's imported (merchant/payment) payee is normally not a transfer payee,
so a naive `transfer_id` write removes the counterpart and unlinks the card —
while the API returns success (`transaction-update` returns `{}`). This exactly
matches the reported incident: card unlinked, bank debit gone, bank ledger
balance increased by the deleted debit.

The supported lifecycle is the opposite direction: a transaction is turned into a
transfer by giving it a **transfer payee**; `transfer.onInsert/onUpdate` then
either creates a paired counter-row (`addTransfer`) or maintains the existing
one. There is currently no supported "join these two existing rows" operation in
this path — `mergeTransactions` (transactions-merge) is a _merge_ (it collapses
the pair into one row), not a link. The design step must either build on a tested
lifecycle or define an explicit, approved conversion process
(PLAN.md requirement D).

**A supported two-row link flow does exist — in the client.** When exactly two
eligible rows are selected, the UI's `onSetTransfer`
(`desktop-client/src/hooks/useTransactionBatchActions.ts`) builds one batch that
sets `category: null`, the opposite account's transfer payee, and the reciprocal
`transfer_id` on **both** rows, then sends it with **`runTransfers: false`** —
deliberately bypassing the generic hooks (which would copy
notes/schedule/amount between the pair). The historical incident is what happens
when the same intent runs through the ordinary update path with hooks enabled:
`removeTransfer` deletes the counterpart. The design's "dedicated linking
operation" can therefore be a server-side promotion of this existing,
human-used flow, plus the extra validations and post-commit verification the UI
flow does not perform.

**Reproduced:** characterization test
`KNOWN TRAP (PLAN.md problem 3): writing transfer_id without a transfer payee deletes the counterpart and leaves the card unlinked`
— bank row becomes `tombstone = 1`, card `transfer_id` is `null`, and the bank
ledger holds zero debits.

### 2.4 Dates and installment periods are inconsistent (observed problem 4)

**Confirmed code candidate.** The sync-server adapter **overrides each Pluggy
transaction date**:

```js
// packages/sync-server/src/app-pluggyai/app-pluggyai.js
function getTransactionDateCorrected(trans) {
  if (trans.creditCardMetadata?.installmentNumber != null) {
    return addMonthsClamped(
      trans.creditCardMetadata.purchaseDate || trans.date,
      trans.creditCardMetadata.installmentNumber - 1,
    );
  }
  return trans.date;
}
```

and the importer consumes only the resulting `date` (`originalDate` is passed
through but never used by loot-core's normalization).

**Documented:** Pluggy's `date` is the **posted date** (ISO8601 UTC); `purchaseDate`
is the original purchase date, present "for transactions made with installments";
`installmentNumber` is the installment position. Therefore:

- for installments 2..n the adapter **shifts the date forward** by
  `installmentNumber − 1` months relative to the purchase date, which explains
  the observed Mercado Livre 2/10 (Sep → Oct in Actual) and 3/10 (Oct → Dec)
  discrepancies;
- for `installmentNumber == 1` the adapter replaces the posted date with the
  purchase date, which explains the Amazon example (posted Jan 6 → Dec 30 in
  Actual).

This is consistent across all three reported examples. Repeated imports do not
compound the shift (the value is recomputed from the same inputs), but it means
Actual carries a **derived** date rather than the provider's posted date, and any
later upstream change to `purchaseDate`/`installmentNumber` moves it again.

**Live validation (2026-10-08, read-only).** The feed reports Mercadolivre 2/10
with `date = 2026-09-28` and `creditCardMetadata.purchaseDate = 2026-09-27` —
internally inconsistent (1/10 posted 2026-08-28), so `purchaseDate` is not a
trustworthy series anchor for this connector. Applying the formula above yields
2026-10-27, matching the reported wrong Actual month (“28 October”); the residual
day remains unexplained (H7). Provider `date` is not automatically statement
truth either — the statement shows 09-24 for this installment (09-28 in the feed)
— so the design must **use the provider date as the ledger date with provenance,
flag statement discrepancies, and never synthesize dates**. Pending/future dates
remain forecasts.

**Fix (2026-10-08):** the override is removed. The adapter now maps every row
with the provider posted date (`preparePluggyTransaction` in
`packages/sync-server/src/app-pluggyai/app-pluggyai.js`), with unit tests
covering installment 1, installment 2+, and both sign conventions
(`app-pluggyai.test.js`). Incoming rows only — existing rows keep their stored
dates. Download cutoffs were already computed from the raw date and the initial
opening-balance math uses amounts, so the change is scoped to stored dates.

### 2.5 Bill assignment is incomplete (observed problem 5)

**In-repo, no drop exists:** the adapter fetches by date window and passes every
row; no code reads `creditCardMetadata.billId` anywhere in the repository
(verified by search). So a transaction missing from a bill-filtered view cannot
be dropped by _this_ code path. Bill-filtered queries, if any, come from the
external tooling (hypothesis).

**Real in-repo gap:** bill/installment metadata is _flattened_ into
`raw_synced_data` but has no structured representation, so:
absence/presence of `billId` cannot drive idempotent updates, and a later bill
assignment cannot be recognized as "same record, new metadata" (it would collide
with the `imported_id` logic instead).

**Live feed check (2026-10-08):** bill objects can show `paid` exceeding `total`
(e.g. paid 7.917,43 vs total 5.117,43), so bill aggregates must be normalized
before use — they cannot be treated as reconciliation truth either.

### 2.6 Opening balances and accounting scope (observed problem 6)

**Confirmed.** On the _initial_ sync the importer fabricates the opening balance
as `reported balance − Σ(downloaded transaction amounts)`:

```js
// sync.ts, processBankSyncDownload initialSync, pluggyai branch
const currentBalance = download.startingBalance;
const previousBalance = transactions.reduce(
  (total, trans) => total - trans.transactionAmount.amount * 100,
  currentBalance,
);
balanceToUse = Math.round(previousBalance);
```

where `startingBalance` is the adapter's `account.balance` (negated for CREDIT)
and `transactions` is the _entire_ fetched list, including PENDING rows. If the
bank-reported balance and the transaction sum have **different scope** (future
installments, 12-month fetch cap, changed start date, mixed currencies), the
difference is silently absorbed into the opening balance. Nothing later invents
adjustments — but the opening number itself is unverified scope absorption, which
is exactly what PLAN.md says must not happen silently. Two smaller confirmed
issues in the same expression: it sums `amount * 100` as floats after per-row
2-dp rounding, and it ignores `transactionAmount.currency` entirely.

---

## 3. Other confirmed behaviors relevant to the contract (design-step input)

| Area                | Confirmed behavior (file)                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money units         | Bank-sync rows carry decimal units; loot-core converts with `amountToInteger = round(amount * 100)`. The adapter rounds to 2 dp before sending.                                                                                                                                              |
| Sign normalization  | Done once, in the adapter, only for `CREDIT` accounts (Pluggy +charge/−payment ⇒ Actual −outflow/+inflow). Bank rows are already Actual-compatible.                                                                                                                                          |
| Pending vs posted   | `sync-import-pending-<acctId>` default `true`; PENDING ⇒ `cleared=false`, POSTED ⇒ `cleared=true`. Provider POSTED never sets Actual `reconciled`.                                                                                                                                           |
| User edits on match | Update path prefers **existing** payee/category/notes/`raw_synced_data`; `cleared = existing \|\| incoming`; `imported_id` is overwritten with the incoming id; **amount is never updated on match**; dates only when `sync-update-dates` (default `false`).                                 |
| Currency            | `transactionAmount.currency` = Pluggy `currencyCode` (transaction currency) even when the amount comes from `amountInAccountCurrency` (account currency) — label/amount mismatch risk; fuzzy matching and the opening-balance sum ignore currency.                                           |
| Fuzzy matching      | Same account + same integer amount + ±7 days; pass 1 same payee, pass 2 first unmatched; `hasMatched` prevents double-use within a batch; `strictIdChecking=false` for all bank-sync accounts by deliberate design (code comment acknowledges the same transaction can arrive with two IDs). |
| Deletion prefs      | `sync-reimport-deleted-<acctId>` default `true`; overridable per call in tests; soft delete = tombstone.                                                                                                                                                                                     |
| Bills               | Not read anywhere; only present inside `raw_synced_data`.                                                                                                                                                                                                                                    |

---

## 3.5 Statement-history evidence (read-only, user-authorized)

Source: the user's finance workspace (`personal-finance/history`, monthly statement
CSVs for Nubank and the credit card, 2025-12 → 2026-10), parsed locally with a
read-only script. These files are statement-side ground truth, **not** the Pluggy
feed, so they settle “what was economically true”, not “what the feed emitted”.

1. **Payments are one-to-one in reality.** Every bank `Pagamento de fatura` debit
   in 2026 pairs with exactly **one** card `Pagamento recebido` credit of the
   identical amount on the same calendar day (one extra card credit predates bank
   coverage). No statement shows two credits for one payment.
   → The reported “two card credits per payment” is a **feed/importer artifact**,
   not the bank’s economic truth.
2. **Installments carry real posted dates, not purchase-date math.**
   - Mercadolivre 10x: 1/10 posted 2026-08-29, 2/10 posted 2026-09-24.
   - Amazon BR VI (NuPay) 12x: monthly, 1/12 on 2026-05-25 … 5/12 on 2026-09-24.
   - Amazon 10x sets post around the 4th–6th each month; Eventim 4x 2/4→4/4
     across Dec–Feb.
     → `purchaseDate + (installmentNumber − 1) months` does **not** reproduce these
     posted dates exactly (off by days here, by whole months in the reported Actual
     cases). The design should prefer the provider’s per-installment `date`.
3. **Nubank’s own model already contains multi-row single events.** Seven pairs in
   2026 share **one** `Identificador` (card-funded Pix produces a bank credit
   `Valor adicionado…` and a bank debit for the Pix out, same id, same day, plus
   the matching card-side `Pix no Crédito` charge). This reinforces the required
   “observation(s) → canonical event → record(s)” model and acceptance test 12.
   The CSV `Identificador` UUIDs are candidate stable provider ids to compare
   against the feed’s `id`/`providerId`.
4. **Refunds/credits exist alongside payments** (`Estorno de …`, `Ajuste a
crédito`, `Desconto Antecipação`, negative `iFood - NuPay`, IOF charges) — must
   not be canonicalized as payment duplicates (acceptance 12).
5. **Six same-day/same-title/same-amount row pairs** exist inside the card
   statements (e.g., two identical small purchases on one day). These are the
   real-world “two legitimate equal-value events” guard cases (acceptance 3).
6. **Coverage is partial:** bank Jan–Oct 2026 (from 2026-01-08); card statement
   cycles 2025-12-06 → 2026-10-08. Supports “absence ≠ deletion” and “report
   partial coverage” requirements.

---

## 4. Remaining hypotheses (not proven)

- **H1 — Live path attribution (structure now confirmed).** The finance workspace
  defines the live workflow: a Personal CFO agent
  (`personal-finance/.opencode/agents/personal-cfo.md`) reads Pluggy through
  dedicated read-only MCP tools (`pluggy_list_transactions`,
  `pluggy_list_credit_card_bills`, `pluggy_refresh_connection`, …) and writes the
  Actual mirror through the native budget MCP (`budget_actual_*`, including a
  paired-transfer tool). The repo's native Pluggy path is a _separate_
  integration. The in-repo mechanisms still explain the observed _outcomes_, but
  the exact tool calls that produced the duplicate credits and the unsafe link
  are external; the bounded feed read of 2026-10-08 (§2.1/§2.4) confirms the
  duplicate structure but not yet the raw discriminator fields (see H2).
- **H2 — Variant A/B semantics (partially resolved).** The live feed confirms two
  rows per payment differing in bill label. The MCP view the live workflow
  actually uses does **not** expose `paymentData`, `cardNumber` or `billId`, so
  the exact Variant A/B discriminator fields remain unverified from this
  workspace; they are not required to recognize the twins, but they may be
  required for a _universal_ automatic rule. Do **not** suppress by metadata
  pattern (the control tests enforce this).
- **H3 — Card balance scope.** Whether `account.balance` for this CREDIT account
  includes future installments (affects every balance comparison and the initial
  opening balance). Requires a live account sample. The live read shows the
  card's `available = limit − balance`, but the scope of `balance` (posted vs
  future-inclusive) remains unverified.
- **H4 — Provider ID churn.** Pluggy documents that IDs are stable across syncs
  (including PENDING→POSTED) **except** when material fields change, where the
  transaction is deleted and recreated with a new id (no link field). The design
  must handle delete/recreate via `providerId`/`providerCode` or attributes
  (PLAN.md acceptance 18/19).
- **H5 — Bill payments as a third representation.** Where bills are supported, a
  payment can appear in `Bill.payments[]` in addition to transactions.
- **H6 — Test coverage of "amount changes upstream".** The current update path
  never updates amounts on a matched row; acceptance 18 (canonical payment amount
  changes upstream) therefore currently neither reconciles nor flags. Confirmed
  as code behavior; incident involvement unknown.
- **H7 — Exact date pipeline.** The repo formula explains the direction of the
  month-scale date shifts, but not the exact day (27 vs 28) or the feed-vs-
  statement variance (28 vs 24). Treat the shift as confirmed in effect and
  formulate the fix as “never recompute; use provider date”, not as a proven
  single-line cause.

---

## 5. What step 1 produced

New file: `packages/loot-core/src/server/accounts/pluggy-card-payments.test.ts`

| #   | Test                                                                                                   | Current result    | Purpose                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `KNOWN ISSUE (problem 1): both card observations import as independent credits`                        | pass              | Characterization: 2 credits × 10,000 c for one payment (excess credit).                          |
| 2   | `expected after equivalence (acceptance 2, Variant B PENDING)`                                         | **expected fail** | Desired: exactly 1 credit.                                                                       |
| 3   | `expected after equivalence (acceptance 2, Variant B POSTED)`                                          | **expected fail** | Desired: exactly 1 credit (observed real-world case).                                            |
| 4   | `control (acceptance 3): two legitimate equal-value payments are not merged or suppressed`             | pass              | Anti-overfit guard: A-like and B-like metadata on genuinely separate payments must both survive. |
| 5   | `control (acceptance 3, same-day ambiguity): identical equal-value payments are both retained`         | pass              | Same-day/same-amount pairs must not be auto-merged (flag instead).                               |
| 6   | `idempotency (acceptance 1): re-importing the same snapshot changes nothing`                           | pass              | Same snapshot twice ⇒ identical rows/ids/amounts.                                                |
| 7   | `KNOWN ISSUE (problem 2): deleted credit returns with same source id, new Actual id`                   | pass              | Characterization of the reimport mechanism.                                                      |
| 8   | `KNOWN TRAP (problem 3): transfer_id write deletes the counterpart`                                    | pass              | Characterization of the unsafe linking mechanism.                                                |
| 9   | `control (acceptance 3, ambiguous constellation): two debits + four credits are never silently merged` | pass              | Live-feed shape: ambiguous pairing must be flagged, never merged.                                |

The fixtures now carry the bill labels (`billReference`) observed in the live feed;
the normalized bank-sync shape cannot see them today, which is itself a documented
gap.

Tests 2 and 3 are wrapped with `it.fails` so the suite stays green while the
desired behavior is unimplemented; when canonicalization lands they will report
as failures until the wrapper is removed (deliberate signal).

Run (Windows, from `packages/loot-core`, after `yarn install`):

```powershell
$env:ENV='node'; node ../../.yarn/releases/yarn-4.17.1.cjs exec vitest --run src/server/accounts/pluggy-card-payments.test.ts
```

Result: `Test Files 1 passed (1) · Tests 7 passed | 2 expected fail (9)`.
Full `src/server/accounts` suite: `5 passed (5)` — no regressions.
The new test file also passes loot-core's strict typecheck (`tsc-strict`: 229 strict files, all passed).

Production code was **not** modified in this step. Live systems were read only:
the user's statement-history exports and one bounded Pluggy feed read through the
finance workspace's MCP (no refresh, no Actual writes, no credentials; see
§2.1/§3.5). The detailed evidence write-up lives in the finance workspace at
`personal-finance/analysis/reports/history-and-feed-findings.md`.

---

## 6. Converged solution (design summary)

The design was developed and cross-reviewed in three rounds with GPT-Sol-6.1
(2026-10-08) and now lives in **`PLUGGY_SYNC_DESIGN.md`**. Key decisions:

- The fix lives in the **repo native path** — the only ledger writer. The
  read-only Pluggy MCP and restricted Actual MCP need no canonicalizer; a
  separate, small follow-up removes the unavailable “paired-transfer tool”
  mention from the CFO agent prompt.
- **First release is conservative:** observation staging + persistent uncertainty
  state + a usable suggestion queue before any automatic canonicalization.
  Ambiguous twins are held, never merged by heuristic; “reject duplicate” means
  keep both events, never discard a payment.
- **Auto-canonicalization** requires authoritative equivalence (shared payment
  reference, or verified connector-specific semantics) plus unique counterpart,
  complete coverage and no conflicts. It is enabled only through **shadow mode**
  after a raw twin capture validates the discriminator fields for this
  connector.
- **Transfer linking** promotes the existing client “Make transfer” flow
  (reciprocal payee + `transfer_id`, hooks bypassed) into a validated server
  operation with in-transaction invariant checks; it is not auto-triggered in
  the first release.
- **Date synthesis is removed for incoming observations only** (no bulk rewrite
  of existing dates); `purchaseDate` and installment metadata stay as evidence.
- **Opening balances and comparisons** come from the canonical ledger only;
  withheld observations are never silently absorbed; mismatch is reported.
- Delivery order: (1) adapter date fix; (2) staging + uncertainty + suggestion
  queue + dry-run/audit; (3) transfer-linking operation; (4) mapping engine +
  atomic materialization; (5) shadow mode → narrow auto-enable; (6) approved
  scoped repair of twins already imported into the fresh budget.

Deliverables 6 (historical migration proposal) and 7 (deployment/rollback)
remain separate and require explicit approval, as does any run against live
financial records.
