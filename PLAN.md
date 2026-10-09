# Project: Reliable Pluggy → Actual Budget Synchronization

## Your role

You are implementing or repairing a financial-data synchronization feature.

You **do not have access to the user’s live Actual budget or the financial assistant’s tools**. Work from the existing code, supported documentation, synthetic fixtures, and the observations below.

Do not assume you can reproduce the live environment immediately. Identify the relevant integration code and explain its current behavior before modifying it.

**Do not change live financial records, reset budgets, trigger bank updates, inspect credentials, or deploy changes without explicit approval.** Develop and test against synthetic data or an explicitly approved disposable budget.

## User goal

The user wants this workflow:

> “I make a transaction in the real world, my bank reports it through Pluggy, and Actual automatically stays updated. I organize categories and budgets in Actual, but I don’t manually recreate transactions or repair duplicate imports.”

Manual CSV imports, repeated duplicate deletion, and periodic account resets are **not acceptable steady-state solutions**.

## Sources and responsibilities

### Pluggy / bank data

Source of truth for bank-reported:

- Cash balances.
- Transactions and their statuses.
- Card bills and payment information.
- Installment metadata and future obligations, where available.

However, the feed can contain multiple representations of the same economic event, incomplete metadata, and forecast entries.

**Bank-reported account balances and statement headers must be distinguished from sums reconstructed from transaction rows.**

### Actual Budget

Editable bookkeeping and budgeting mirror:

- Categories and rules.
- Notes.
- Budget allocations.
- Schedules.
- Imported transaction records.
- Transfers and reconciliation status.

User-maintained information must survive synchronization.

The user has two accounts:

1. **Nubank:** bank cash account.
2. **Credit Card:** card purchases, credits and payments.

Do not collapse these into one account.

## Observed problems

These are observations, not a complete root-cause diagnosis.

### 1. Card payments have two source representations

For several payments, the source contains:

- One bank debit.
- Two card credits with the same payment amount and date.
- Different source transaction IDs for the card credits.
- Different bill assignments or metadata.

Observed metadata pattern:

**Variant A**
- `paymentData.paymentMethod` is `DEBIT`.
- Status is `POSTED`.
- A bill ID is present.
- Card-number metadata is absent.

**Variant B**
- No payment method.
- Card-number metadata is present.
- Usually `POSTED`, occasionally `PENDING`.
- May belong to another bill or an open forecast period.

A direct Pluggy read also showed these two representations. Therefore, this is **not proven to be a duplicate invented solely by the importer**.

The importer currently appears to treat both representations as independent credits. That incorrectly reduces Actual’s recorded card debt.

Do not assume the metadata pattern is universally sufficient to discard Variant B. Validate its meaning and scope.

### 2. Deleting duplicates does not prevent reimport

After duplicate card credits were deleted from Actual, a subsequent update recreated some of them:

- New Actual internal transaction IDs.
- The same source import IDs as the deleted copies.

This shows that deletion alone is not durable prevention.

Investigate:

- Existing source-ID matching.
- Deleted-record handling.
- Import reconciliation behavior.
- Whether the importer deliberately or accidentally re-adds deleted records.
- Whether deduplication is limited to identical source IDs rather than equivalent economic events.

The observation does **not** prove that Pluggy generated new IDs during that refresh.

### 3. Existing-record transfer linking was unsafe

An attempted native transaction update set a card record’s `transfer_id` to the existing bank counterpart’s transaction ID.

The tool returned success, but verification showed:

- The card record remained unlinked.
- The matching bank debit disappeared.
- The bank ledger balance increased by the deleted debit amount.

The bank record was subsequently recreated.

**Do not implement linking by blindly writing reciprocal `transfer_id` fields.**

Investigate the supported Actual transfer lifecycle and the adapter’s handling. A successful API response is not sufficient evidence of a correct result.

Creating a fresh paired transfer while retaining both existing imported payment records would also duplicate the event.

### 4. Dates and installment periods are inconsistent

Examples observed between the existing mirror and direct bank data:

- An Amazon installment dated 30 December in Actual was reported as posted on 6 January by the direct feed.
- Mercado Livre installment 2/10 was dated 28 October in Actual but appeared on 28 September in the direct feed.
- Installment 3/10 appeared in December in Actual but October in the direct feed.

Investigate whether dates are being:

- Confused with purchase dates.
- Derived from bill labels.
- Shifted by an installment-number calculation.
- Shifted by timezone conversion.
- Reinterpreted during repeated imports.

Do not invent installment dates from descriptions or bill labels when reliable source metadata exists.

### 5. Bill assignment is incomplete

Some card transactions have no bill ID or bill label.

An installment missing from the open-bill view was present in the date-based transaction feed and in the user’s CSV statement.

Therefore:

> Missing from a bill-filtered query does not mean missing from the account.

Do not drop such transactions or automatically create a second copy when bill metadata later appears.

### 6. Opening balances and accounting scope are unclear

The existing Actual card opening balance is unverified. It must not be “fixed” by inserting an arbitrary adjustment to make today’s balance match.

The bank’s total card obligation includes future commitments, while a posted-transaction ledger may not.

**Comparing those two figures directly can produce a false reconciliation error.**

Historical cleanup is a separate, explicitly approved migration—not a side effect of implementing synchronization.

## Required accounting contract

Implement and document a consistent model:

### Bank account

- Import real bank movements once.
- Preserve the correct signs.
- Reconcile against the bank-reported cash balance, using an explicitly established opening balance and cutoff.
- Report differences; never silently invent adjustments.

### Card account

- Import posted purchases, fees, refunds and payment events once.
- Distinguish pending observations and forecasts from posted financial events.
- Track future installment commitments separately from posted spending.
- Do not import the full purchase total and every installment as additional expenses.
- Do not insert all future debt into the opening balance and subsequently charge the same installments again.

### Card payments

One economic payment has:

- A debit in the bank account.
- A credit in the card account.
- A valid transfer relationship.

It is **not additional purchase spending or earned income**.

### Balance comparisons

Expose separate measures:

- Bank cash.
- Posted card ledger balance.
- Current statement obligation.
- Future installment commitments.
- Total bank-reported card obligation.

Only compare measures with compatible scope and dates.

Do not claim every card balance must equal the bank’s total future-inclusive liability.

## Synchronization requirements

### A. Idempotency

Repeatedly importing the same snapshot must not:

- Add transactions.
- Change balances.
- Repeatedly shift dates.
- Repeatedly rewrite categories or notes.
- Create additional transfer counterparts.

Use stable identity based on connection, account and source record identity where available.

Also support multiple source observations belonging to one canonical economic event.

### B. Economic-event reconciliation

Source-ID deduplication alone is insufficient for the observed card payments.

Design an auditable mapping:

> Source observation(s) → canonical economic event → Actual record(s)

Matching should use reliable evidence such as:

- Account identity and type.
- Opposite payment amounts.
- Payment metadata.
- Status.
- Bill relationships.
- Dates within a justified settlement window.
- Unique bank-side counterpart.
- Documented provider behavior.

**Do not merge solely because date, description and amount match.** Two legitimate payments can have identical amounts.

If matching is ambiguous, retain the evidence and flag it for review rather than guessing.

### C. Pending-to-posted transitions

Handle:

- Same source ID changing status.
- Different source IDs representing a documented pending-to-posted transition.
- Changed bill metadata.
- Forecast entries later becoming posted.

A transition must not leave both an old observation and a new posted expense contributing to totals.

Define whether pending entries appear in Actual or remain outside the posted ledger. Do not equate provider `POSTED` with Actual’s manually verified `reconciled` flag.

### D. Transfers

Use a supported, tested Actual transfer operation or lifecycle.

Requirements:

- Exactly one bank debit and one card credit per confirmed payment.
- No extra financial rows created on top of imported counterparts.
- Preserve source-ID associations and relevant imported evidence.
- Preserve each side’s real settlement date if the supported model permits it.
- Linking existing records must not alter either account’s balance.
- Uncertain or partial linking must stop and be reported.

If Actual’s supported API cannot join two existing records directly, explain that limitation and design a safe, explicit conversion process. Do not manipulate undocumented pointers.

### E. Preserve user edits

Determine field ownership:

**Source-owned**
- Account/source identity.
- Bank-reported amounts and status.
- Posting and purchase dates, according to documented semantics.
- Bill and installment metadata.

**User-owned**
- Categories.
- Notes and tags.
- Budget allocations.
- Manual categorization corrections.
- Reconciliation decisions.

Define conflict handling for manually corrected source-owned fields.

Do not overwrite human changes merely because another sync occurs.

### F. Deleted records and suppression

Define deliberate behavior for:

- User-deleted records.
- Duplicate representations intentionally suppressed.
- Records deleted as part of a transfer conversion.
- Source records no longer returned because the query window changed.

Absence from a snapshot is not necessarily cancellation or deletion.

The same intentionally suppressed duplicate must not silently return under a new Actual ID.

A repair/reimport operation must be explicit and scoped, not equivalent to a normal sync.

### G. Dates, amounts and currencies

- Use exact integer cents or Decimal for money.
- Confirm units at each boundary: Actual uses integer cents; source adapters may use decimal currency units.
- Normalize raw source signs exactly once.
- Already-normalized Pluggy MCP rows use negative for outflow and positive for inflow on both account types.
- Never sum original foreign-currency evidence as additional spending.
- Group totals by currency.
- Treat calendar dates as calendar dates; avoid timezone-induced day shifts.
- Keep posting date, purchase date, statement due date and forecast period distinct.
- An open `~YYYY-MM` bill label is not a confirmed due date.

### H. Safe execution and recovery

- Support a dry-run showing proposed creates, updates, links, suppressions and conflicts.
- Use supported batching/atomicity where available.
- If a multi-step change fails, report the actual partial state and stop.
- Verify uncertain mutations before considering a retry.
- Do not blindly retry a timed-out write.
- Export a backup before destructive or bulk migration work; abort that work if export fails.
- Never restore a backup automatically.
- Verify outcomes by rereading records and checking counts, identities, amounts, links and balances.

### I. Refresh versus import

Keep these distinct:

1. Requesting a Pluggy connection refresh.
2. Waiting for source synchronization.
3. Reading the refreshed source.
4. Importing/reconciling into Actual.
5. Verifying the mirror.

A refresh request is not proof of completed synchronization.

Do not assume Actual’s native bank-sync operation supports Pluggy: the exposed operation advertised GoCardless/SimpleFIN support, and a test timed out. Inspect the actual integration path.

## Synthetic fixture to start with

Amounts below are synthetic **integer cents**, not live records:

```json
{
  "bankMovement": {
    "sourceId": "bank-payment-001",
    "account": "bank",
    "date": "2026-09-25",
    "amountCents": -10000,
    "status": "POSTED",
    "description": "Pagamento de fatura"
  },
  "cardObservations": [
    {
      "sourceId": "card-payment-debit-001",
      "account": "card",
      "date": "2026-09-25",
      "amountCents": 10000,
      "status": "POSTED",
      "paymentMethod": "DEBIT",
      "billReference": "closed-bill-A",
      "cardNumberMetadataPresent": false
    },
    {
      "sourceId": "card-payment-other-001",
      "account": "card",
      "date": "2026-09-25",
      "amountCents": 10000,
      "status": "PENDING",
      "paymentMethod": null,
      "billReference": "open-forecast-B",
      "cardNumberMetadataPresent": true
    }
  ]
}
```

Expected result, **once the equivalence is established**:

- One bank debit of 10,000 cents.
- One card credit of 10,000 cents.
- One valid payment transfer.
- Both card source observations retained in an audit mapping.
- No second card credit.
- Reimporting the fixture changes nothing.

Also test the second card observation as `POSTED`, because most observed extra representations were posted rather than pending.

## Minimum acceptance tests

1. Same snapshot imported twice: no additional rows or balance changes.
2. Two proven representations of one card payment: one economic payment.
3. Two legitimate equal-value payments: neither incorrectly merged.
4. Pending-to-posted transition: no double spending.
5. Previously suppressed duplicate returns: no new Actual credit.
6. Missing bill metadata later appears: existing record updated, not duplicated.
7. Linking existing payment counterparts: row counts and balances unchanged.
8. Transfer failure after a partial step: detected and recoverable without blind retry.
9. Purchase date differs from posting date: both semantics preserved.
10. Future installment: does not count as current posted spending.
11. Installment transitions into the posted period: counted once.
12. Refund, fee and credit-funded Pix: not confused with card-payment duplicates.
13. User changes a category or note: subsequent sync preserves it.
14. Mixed currencies: no cross-currency totals.
15. Timeout or process restart: no duplicate mutations on recovery.
16. Partial source coverage: incomplete reconciliation is reported explicitly.
17. Opening-balance mismatch: no silent balancing transaction.
18. Canonical payment amount changes upstream: detected and safely reconciled or flagged.
19. Forecast installment dates change: no repeated month shifting or duplicate commitments.

## Deliverables

1. **Root-cause report:** observed behavior, confirmed cause, remaining hypotheses.
2. **Accounting contract:** what each Actual account balance represents.
3. **Synchronization design:** identity, field ownership, transitions and conflict handling.
4. **Implementation and automated tests.**
5. **Dry-run/audit output** understandable to a nontechnical user.
6. **Historical migration proposal**, separate from normal synchronization and requiring approval.
7. **Deployment and rollback procedure**, with no automatic destructive reset.

Start by tracing the existing importer and producing a small failing test for the duplicate-payment case. Then implement the smallest robust fix.

**Success means the user transacts normally, Actual stays updated automatically, manual organization survives, and repeated synchronization does not require financial cleanup.**
