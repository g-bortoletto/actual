# Pluggy → Actual synchronization — historical migration proposal

Status: **proposal only; requires explicit approval before any execution.**
This is PLAN.md deliverable 6. It is deliberately separate from normal
synchronization: a safer importer does not automatically repair records that
were already imported by the old pipeline, and nothing here runs as a side
effect of a sync.

## What may need repair

The live budget (rebuilt fresh on 2026-10-07) has been maintained by the
native Pluggy sync with the old pipeline. Two classes of residue are possible,
depending on what was synced before the fix was deployed:

1. **Twin card credits** — both representations of a payment imported as
   separate rows (the observed live behavior, see PLUGGY_SYNC_RCA.md §2.1).
   Symptoms: the card account shows two equal credits for one payment; card
   debt understated by one credit per affected payment.
2. **Shifted installment dates** — card installment rows imported before the
   adapter date fix carry dates recomputed from `purchaseDate` +
   `installmentNumber`, not the provider posting date (RCA §2.4).
3. **Unlinked payment pairs** — bank debit and card credit(s) imported
   correctly but never joined as a transfer.

The migration window may be small: the budget is fresh and the fix limits new
residue from deployment onward. The dry-run report establishes the actual
extent; do not assume it is zero.

## Procedure (all steps explicitly approved, in order)

1. **Backup**: export the budget; verify the export opens. Abort the whole
   migration if the export fails. Never auto-restore.
2. **Dry-run report** (read-only), per account:
   - twin groups: equal positive amounts, same/adjacent dates, card account,
     each row's `imported_id`, dates, notes, categories, transfer state;
   - shifted dates: card rows whose staged raw observation
     (`bank_sync_observations`) proves a different provider date than the
     stored one — never rows the user edited or reconciled;
   - unlinked pairs: bank debit ↔ card credit candidates with amounts summing
     to zero, with every other candidate listed as a conflict;
   - per-account row counts and sums before any change.
3. **Review and approve per item** — this is a human decision list, not a
   heuristic batch. The report is copied and the approved decisions are
   recorded in the migration log (who approved what, with evidence).
4. **Apply approved changes only**:
   - duplicates: remove the alias row **only with explicit approval per
     group**; keep the representative (prefer posted), preserve its id,
     category, notes, and imported evidence; write the suppression record so
     the alias cannot return (same mechanism as the review queue);
   - dates: update the stored date to the provider date for approved rows;
   - links: use the validated `transactions-link-transfer` operation only —
     never raw `transfer_id` writes, never fresh paired rows.
5. **Verify**: re-read every touched row and both accounts' counts and sums;
   reciprocal `transfer_id`s; the review queue shows no new items; the
   dry-run report re-run shows zero remaining candidates of each class.
6. **Report**: write the before/after table and attach it to the migration
   log. If any step fails or is uncertain, stop and report the actual state —
   do not retry blindly and do not continue to later steps.

## Rollback

- Code and normal sync continue regardless of the migration.
- Data rollback is restoring the pre-migration backup — manual, approved,
  never automatic.
- The migration itself never resets the budget, never rebuilds accounts, and
  never adjusts opening balances.

## What this proposal explicitly refuses

- Bulk deletion of anything identified only by a metadata pattern.
- Merging or deleting rows for two legitimate equal-value payments.
- "Fixing" balances with adjustment transactions.
- Changing user-owned fields (categories, notes, reconciliation state).
- Running during a normal sync, or automatically after deployment.
