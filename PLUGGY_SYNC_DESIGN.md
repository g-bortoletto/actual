# Pluggy → Actual synchronization — converged design

Status: conservative first release, approved through structured review
(GPT-Sol-6.1 review rounds, 2026-10-08). Companion evidence report:
`PLUGGY_SYNC_RCA.md`. This document is the PLAN.md deliverable 3
(“Synchronization design”) in draft form.

Conventions: **confirmed** = verified in code/evidence; **chosen** = design
decision; **open** = needs live evidence before automation.

## 0. Scope and principles

- **Fix target: the repo's native Pluggy path** (sync-server adapter + loot-core
  reconciliation). It is the only ledger writer today. The external stack —
  read-only custom Pluggy MCP and the restricted Actual MCP (24 reads + 2 narrow
  bookkeeping writes) — needs no canonicalizer.
- **Principles:** never silently present an unreliable balance; never merge
  without authoritative equivalence; hold and flag instead of guessing; preserve
  user edits; exact integer cents; calendar dates; dry-run and audit first; no
  blind retries; historical repair is separate and explicitly approved.
- **Honest limitation:** the interim (staging + suggestion queue) removes repeated
  cleanup but still requires human adjustments; full zero-manual-repair arrives
  only after connector semantics are verified and the rule runs in shadow mode.

## 1. Actors

| Actor                                          | Role                                                                                     | Fix scope                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Native sync (`account_sync_source='pluggyai'`) | Sole ledger writer; runs daily                                                           | **Primary fix target**                                                          |
| Custom Pluggy MCP                              | Faithful read-only viewer (no transaction dedup; signs normalized; bill labels rendered) | None                                                                            |
| Restricted Actual MCP                          | 24 read tools + 2 bookkeeping writes; cannot import/transfer                             | None                                                                            |
| Personal CFO agent                             | Analysis/budgeting; external                                                             | Separate: remove the unavailable “paired-transfer tool” mention from its prompt |

Deployment target: pinned Actual v26.10.0, matching this repo; ship through the
(homelab) deployment procedure as a separate deliverable.

## 2. Normalization contract (source boundary)

- **Units and signs:** Pluggy decimal amounts convert to integer cents exactly
  once (`amountToInteger`). The adapter flips the CREDIT sign exactly once; no
  other layer flips again.
- **Dates:** provider `date` is the ledger date. `purchaseDate`, installment
  number/count, and bill references are attributes. **Delete
  `getTransactionDateCorrected`** (chosen). No date synthesis, no timezone day
  shifts; `~YYYY-MM` is a forecast period, not a due date.
- **Bills:** `billId`/forecast are preserved as evidence and never used to drop
  rows. Bill aggregates (`paid`/`total`) are not reconciliation truth.
- **Currency:** group totals by currency; never sum `valor_orig`; no
  cross-currency additions.
- **Status:** PENDING/forecast ≠ posted. Provider `POSTED` never sets Actual
  `reconciled`.

## 3. Identity model (new persisted state)

Observation-first model, persisted in the budget database following existing
schema/migration patterns (names illustrative):

| Store          | Content                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observations` | connection + source account + source id (+ provider id), observed fields (raw + hash), first/last seen, status                                             |
| `events`       | canonical economic event: kind (payment/purchase/refund/fee/…), currency, amounts, settlement window, state (candidate → confirmed/rejected), rule version |
| `mappings`     | observation ↔ event ↔ Actual transaction(s); aliases; suppression records; decision + evidence + version; journal of applied changes                       |
| `uncertainty`  | per account: materialized balance, withheld observations and possible contribution (range/scenario), coverage marker                                       |

Decision semantics (chosen):

- **“Reject duplicate hypothesis” means keep both events**, never discard a
  payment.
- **Suppression is explicit** and persisted; it survives deletion/reimport.
- **ID churn:** reassociation only via `providerId`/`providerCode` after their
  uniqueness/scope/stability are established; attribute similarity alone →
  review. Known-alias replay prevention and unknown-ID reassociation are
  separate guarantees.

## 4. Staging precedes reconciliation

Every downloaded row is staged as an observation **before** ordinary matching.
Held/ambiguous observations must never reach: fuzzy matching, rules, transfer
creation, opening-balance summation, or balance presentation (other than the
withheld/uncertainty view). Otherwise the uncertainty layer documents corruption
after the fact instead of preventing it.

## 5. Canonicalization policy (twin payments)

- **Detector (suggestion level):** same card account, positive amounts, equal
  integer cents, dates equal/adjacent; a candidate bank debit; provider
  discriminator differences (e.g. `operationType=PAGAMENTO_FATURA`, bill linkage
  vs forecast, `paymentData`/`cardNumber` presence).
- **Auto-canonicalize only with authoritative equivalence:** a shared payment
  reference, or verified connector-specific semantics, **plus** exactly one
  eligible bank counterpart, complete coverage/pagination, no competing
  candidates/refunds/conflicts, a justified settlement window, and a persisted
  mapping with evidence. Open: the connector-specific semantics must be verified
  from a raw twin capture before any auto path is enabled.
- **Representative:** prefer posted; once mapped, keep the existing Actual id;
  closed-bill linkage is secondary evidence and never overrides posted/forecast
  semantics.
- **Ambiguity** (e.g. two debits + four credits): never auto-merge; withhold card
  observations, import independently verified debits, surface uncertainty.
- **Negative cases are first-class tests:** genuine equal payments, same-day
  twins, refunds/IOF/Pix-no-Crédito, overpayments/reversals, pending transitions,
  provider ID changes.

## 6. Materialization

- Bank debit imports normally when independently verified.
- One card credit per confirmed payment event; the other observation becomes an
  alias with full evidence.
- Amounts are never silently updated on a match; canonical-event application may
  update source-owned fields only within the field-ownership rules below.

## 7. Transfer linking (dedicated operation)

Existing precedent (confirmed): the client “Make transfer” flow
(`onSetTransfer`) updates **both** rows with reciprocal transfer payees and
`transfer_id`s and sends the batch with **`runTransfers: false`**, deliberately
bypassing the generic hooks that copy notes/schedule/amount — and that, with
hooks enabled, delete the counterpart.

Chosen design: promote that flow to a validated server operation.

- Validations: two live, distinct, eligible, unsplit rows; different accounts;
  same currency; amounts sum to zero; no conflicting links; refuses
  closed/off-budget/child rows per policy; an already-valid pair is a no-op.
- Single atomic batch: reciprocal links + payees; explicit transfer-category
  semantics (on-budget transfers have no category; prior category evidence is
  preserved in the journal); generic field-copying hooks bypassed; invariants
  (exactly two rows linked, balances unchanged, imported fields preserved)
  validated **inside** the transaction; post-commit verification is an
  additional check, not the atomicity guarantee.
- Partial-state repair: idempotent; refuses conflicting links or intervening user
  edits; never overwrites user changes.
- **Not auto-triggered by sync in the first release**; invoked only by an
  approved event correspondence (or a deliberate manual action).

## 8. Deletion, suppression, coverage

- Absence from a partial window is not deletion; only explicit provider signals
  or approved decisions change state.
- Intentional suppression persists; never flip the global `reimportDeleted`
  default. User-deleted records resolve through mappings/suppression decisions,
  not by re-creation guessing.
- Repair/reimport is explicit and scoped, never a side effect of normal sync.
- Coverage markers per sync window; incomplete coverage is reported and blocks
  auto decisions (suggest/hold only).

## 9. Balances and uncertainty presentation

Persist and present, per account:

- materialized posted balance;
- withheld observations and their possible contribution — **range or labeled
  scenario**, not a false exact impact, until equivalence is established;
- previously imported suspected duplicates, flagged as uncertain.

Opening balance: explicit boundary; computed only from a canonical,
scope-compatible ledger; never silently absorbs withheld observations; mismatch
is reported, never adjusted silently.

## 10. Audit, dry-run, execution safety

- Planner output (nontechnical): proposed creates/updates/links/suppressions/
  withheld items and conflicts; readable without tools.
- Execution: budget checkpoint before destructive/bulk work, abort if export
  fails, never auto-restore; no blind retries; partial failures report the actual
  state and stop; decision state syncs across clients like other local-first
  data.

## 11. Delivery order and gates

1. **Adapter date fix** (incoming observations only; no bulk rewrite of existing
   dates) + tests — **done 2026-10-08** (`preparePluggyTransaction`, tests in
   `app-pluggyai.test.js`). Cutoff/opening-balance effects checked: both were
   already computed from raw dates/amounts, so only stored dates changed.
2. **Observation staging + uncertainty state + suggestion queue + dry-run/audit**
   (persistent, syncable) — *in progress 2026-10-08*: storage foundation
   landed (`bank_sync_observations` device-local staging table, synced
   `bank_sync_review_items` + `bank_sync_decisions`, module
   `sync-observations.ts`, migration validated by the additive-migration
   checks); detector + wiring landed (`pluggy-sync-review.ts` — structural
   detection of ambiguous card-credit groups; `processBankSyncDownload`
   stages every Pluggy observation, holds ambiguous credits out of the ledger
   and out of opening-balance math, queues review items; 15 dedicated tests).
   Review UI + audit output landed 2026-10-08: `bank-sync-review` modal with
   explicit decision actions and "recorded; not yet applied" honesty,
   account-level "Sync incomplete" badge beside the balance,
   sync-completion notification separating fetch success from accounting
   completeness, reconcile-modal gating note, and a plain-language copyable
   audit summary; the `bank-sync-review-decide` handler records decisions
   without touching the ledger. Desktop-client tests and strict typechecks
   green.
3. **Transfer-linking operation** + tests (internal capability, not
   auto-triggered) — *landed 2026-10-08*: `transactions-link-transfer`
   handler + `link-transfer.ts` (strict preconditions, dry-run, reciprocal
   payees/pointers applied with transfer hooks bypassed, post-write
   verification of amounts/accounts/dates, idempotent repeat; 9 tests).
4. **Canonical mapping engine**: persisting decisions with evidence/version and
   atomic materialization; invoke linking only for approved correspondences —
   *landed 2026-10-08*: `bank-sync-review-apply` handler +
   `review-materialize.ts` (posted-preferred representative, alias suppression
   via `bank_sync_event_mappings`, idempotent apply, decision `applied_at`
   journal); `bank_sync_review_items.raw_observations` makes materialization
   device-independent; 7 tests including alias-replay prevention. The review
   modal auto-applies after a decision and offers "Apply now" for
   recorded-but-unapplied items. Linking stays a separate deliberate action
   until step 5 (shadow mode).
5. **Shadow mode** for the twin rule (suggestions only) until: raw twin capture →
   connector semantics verified → negative tests pass → then narrow auto-enable
   with rule version, monitoring, and fallback to hold on any violated
   prerequisite. *Status 2026-10-08:* the current pipeline **is** the shadow
   mode — it holds and suggests, never auto-decides. The remaining
   prerequisite (a raw twin capture to verify connector semantics) is a
   live-data action outside the code; auto-enable stays gated on it.
6. **Scoped approved repair** of twins already imported into the fresh budget
   (dry-run first). *Status 2026-10-08:* proposal written
   (`PLUGGY_HISTORICAL_MIGRATION.md`); execution requires explicit approval.

Tests to add across the above: partial sync, replay/reordered input, concurrent
syncs, delayed second account, decision-state sync across clients, note
conflicts, hook failure, crash mid-link, currency mismatch, same-day equal
payments, delete→reimport, ID churn.

### Acceptance coverage (PLAN.md minimum acceptance tests)

Automated today: **1** (same snapshot twice — `pluggy-sync-review.test.ts`,
`pluggy-payment-flow.test.ts`), **2** (two representations → one payment —
`pluggy-payment-flow.test.ts`, `review-materialize.test.ts`), **3**
(equal-value payments never merged — detector controls in
`pluggy-card-payments.test.ts`, `pluggy-sync-review.test.ts`, flow test),
**5** (suppressed duplicate returns — `review-materialize.test.ts`, flow
test), **7** (linking existing counterparts — `link-transfer.test.ts`, flow
test), **9** (purchase vs posting date — `app-pluggyai.test.js`), **15**
partially (idempotent re-apply/re-sync; crash simulation open), **18**
partially (payload revision detection in `sync-observations.test.ts`).

Open, gated on the step-5 prerequisites (raw twin capture, verified connector
semantics): **4** (pending→posted transitions — pending rows are held and
never posted twice, but cross-id transitions need live semantics), **6**
(bill metadata appearing later), **10–11** (future installments in the posted
period), **12** (refund/fee/Pix discrimination), **13** fully (field-ownership
conflict tests beyond the existing preserve-on-update behavior), **14**
(currency grouping beyond evidence), **16** (coverage markers), **17**
(opening-mismatch reporting), **19** (forecast date changes across syncs).

## 12. Open items

- Raw twin capture for discriminator verification (prerequisite for step 5).
- Verified uniqueness/stability of `providerId`/`providerCode` for this connector.
- CFO prompt follow-up (remove unavailable paired-transfer mention).
- Deliverables 6 (`PLUGGY_HISTORICAL_MIGRATION.md`) and 7
  (`PLUGGY_SYNC_DEPLOYMENT.md`) are written; both remain separate and require
  explicit approval to execute.
