BEGIN TRANSACTION;

-- Device-local staging of raw source observations (the audit evidence behind
-- every sync). Re-derivable from the provider, so it is deliberately not
-- synced; it is written via raw SQL only and never through db.insert/update.
CREATE TABLE bank_sync_observations
  (id TEXT PRIMARY KEY,
   account_id TEXT,
   source TEXT,
   source_id TEXT,
   first_seen TEXT,
   last_seen TEXT,
   payload TEXT,
   payload_hash TEXT);

CREATE INDEX bank_sync_observations_account_idx
  ON bank_sync_observations (account_id, source_id);

-- Synced review queue: held observations and suspected duplicates that need a
-- user decision before they can reach the ledger. `state` stays 'pending'
-- until the user decides, and 'applied' only after the materialization step
-- has actually changed the ledger.
CREATE TABLE bank_sync_review_items
  (id TEXT PRIMARY KEY,
   account_id TEXT,
   kind TEXT,
   state TEXT,
   observation_ids TEXT,
   evidence TEXT,
   created_at TEXT,
   updated_at TEXT,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX bank_sync_review_items_account_idx
  ON bank_sync_review_items (account_id, state);

-- Synced decision journal. `applied_at` stays NULL until the materialization
-- step has applied the decision; recording a decision alone never touches the
-- ledger.
CREATE TABLE bank_sync_decisions
  (id TEXT PRIMARY KEY,
   review_item_id TEXT,
   action TEXT,
   observation_ids TEXT,
   decided_at TEXT,
   applied_at TEXT,
   tombstone INTEGER DEFAULT 0);

COMMIT;
