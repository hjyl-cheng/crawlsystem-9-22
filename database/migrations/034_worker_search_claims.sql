-- Lease release must not erase the Worker responsible for a final search outcome.
ALTER TABLE control.query_runs ADD COLUMN last_worker_id text;
ALTER TABLE control.query_runs ADD COLUMN claimed_at timestamptz;
UPDATE control.query_runs SET last_worker_id=worker_id,claimed_at=started_at WHERE worker_id IS NOT NULL;
