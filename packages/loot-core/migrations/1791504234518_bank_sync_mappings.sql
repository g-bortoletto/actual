BEGIN TRANSACTION;

-- The full raw rows of a review item, so a decision can be materialized on
-- any synced device even when the device-local observation staging is empty.
ALTER TABLE bank_sync_review_items ADD COLUMN raw_observations TEXT DEFAULT NULL;

-- Observation <-> canonical event <-> Actual record journal. Rows with
-- `applied_at` set are the durable suppression record: their alias
-- observations must never reach the ledger again, even after deletion or
-- source-id churn.
CREATE TABLE bank_sync_event_mappings
  (id TEXT PRIMARY KEY,
   review_item_id TEXT,
   account_id TEXT,
   representative_observation_id TEXT,
   alias_observation_ids TEXT,
   actual_transaction_ids TEXT,
   decision TEXT,
   created_at TEXT,
   applied_at TEXT,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX bank_sync_event_mappings_account_idx
  ON bank_sync_event_mappings (account_id, applied_at);

COMMIT;
