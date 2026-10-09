# Pluggy → Actual synchronization — deployment and rollback

Status: procedure draft (PLAN.md deliverable 7). Deployment requires explicit
approval; nothing in this document is executed automatically.

## What ships

The synchronization fix is code in this repository:

| Area                      | Change                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| `sync-server` adapter     | Installment dates are no longer synthesized (provider date kept as-is).   |
| `loot-core` sync pipeline | Observation staging, duplicate-payment review queue, alias suppression.  |
| `loot-core` transactions  | Validated `transactions-link-transfer` operation (not auto-triggered).   |
| `desktop-client`          | "Sync incomplete" badge, review modal, audit summary, reconcile gating.  |
| Budget DB                 | Three new synced tables + one device-local table (additive migrations).  |

The user's live deployment runs a pinned Actual v26.10.0 image matching this
repo (see homelab docs). Deployment means building a new pinned image/artifact
from this branch and following the homelab procedure.

## Preconditions

1. All test suites and typechecks green on the exact revision to deploy
   (loot-core, sync-server, desktop-client).
2. A backup export of the live budget has been produced and **verified
   readable**; abort deployment if the export fails.
3. The dry-run expectations below have been written down before the first
   sync (so the result can be compared, not rationalized afterwards).

## Rollout

1. **Backup**: export the budget from the current running version. Verify the
   file opens. This is the only rollback anchor for data; code rollback is
   separate.
2. **Deploy** the new pinned artifact. No data migration runs beyond the
   additive schema migrations.
3. **First sync, watched**: trigger one bank sync for the credit card account.
   Expected in the new pipeline:
   - known duplicate-payment groups are **held**, not imported twice;
   - the account shows "Sync incomplete — N to review";
   - the ledger row count for the sync window changes only by genuinely new
     rows.
4. **Review pass**: resolve the held items in the review modal (confirm one
   payment / confirm separate payments / leave unresolved). Each decision is
   applied immediately; verify the card ledger gains exactly one credit per
   confirmed payment.
5. **Bank account sync**: trigger the bank account sync; verify the debit
   side imports normally.
6. **Verification** (see PLUGGY_SYNC_RCA.md for the measures):
   - row counts and sums per account before/after each step;
   - `transfer_id` reciprocal where links were applied;
   - `balance_current` (provider-reported) vs the materialized ledger
     difference is understood and scope-compatible;
   - the review queue is empty or every remaining item is deliberately left
     unresolved.
7. **Rollback decision point**: if verification fails, stop syncing, roll
   back the artifact to the previous pinned version, and keep the backup.
   Do not "fix" balances with adjustment entries.

## Rollback behavior (honest limitations)

- **Code rollback is clean**: the previous version ignores the new tables.
- **Data rollback is not automatic**: rolling the artifact back does **not**
  undo imports, decisions, or links already applied. Restoring the budget
  from the backup is a separate, manual, explicitly approved action.
- **After rollback, duplicates return**: the old pipeline has no review queue
  and will import both representations of a payment again. This is the known
  behavior the fix removes; rollback is a temporary state, not a steady one.
- Review items and mappings stay in the database through rollback and are
  honored again if the new version is re-deployed.

## What this procedure never does

- Never resets the budget or re-runs the historical repair.
- Never restores a backup automatically.
- Never retries a timed-out or uncertain write blindly (verification first,
  see the design's execution-safety rules).
- Never adjusts an opening balance to force a match.
