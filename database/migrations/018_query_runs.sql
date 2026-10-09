-- Query runs (24.8 §5.2): one frozen search of a binding (window, sort, locale, country, category),
-- claimed by a Worker under a lease. A retry reuses the run and its parameters (Q-07); the binding
-- clock settles in the same transaction as the run (Q-03). Channels a run found are kept per run
-- (lineage, BC-16); channels new to the system become candidates once. Additive only: Data API
-- permits gain an optional run owner, and plan-owned permits are unchanged.
CREATE TABLE m1.query_runs (
  run_id uuid PRIMARY KEY, workspace_id text NOT NULL, binding_id uuid NOT NULL REFERENCES m1.query_bindings(binding_id),
  params jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0), failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  worker_id text, lease_expires_at timestamptz, retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, finished_at timestamptz,
  pages integer, stop_reason text CHECK (stop_reason IN ('list_end','max_pages','low_yield')),
  found_channels integer, new_channels integer, qualified_new integer,
  last_error text CHECK (length(last_error) <= 40)
);
CREATE UNIQUE INDEX query_runs_one_open ON m1.query_runs(binding_id) WHERE state IN ('PENDING','RUNNING');
CREATE INDEX query_runs_recent ON m1.query_runs(workspace_id, created_at DESC);
CREATE INDEX query_runs_open ON m1.query_runs(workspace_id, state, retry_at) WHERE state IN ('PENDING','RUNNING');
CREATE INDEX query_runs_binding ON m1.query_runs(binding_id, created_at DESC);
CREATE INDEX query_runs_finished ON m1.query_runs(workspace_id, finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE TABLE m1.query_run_channels (
  run_id uuid NOT NULL REFERENCES m1.query_runs(run_id), channel_id text NOT NULL,
  page integer NOT NULL, video_id text NOT NULL, known_before boolean NOT NULL,
  PRIMARY KEY (run_id, channel_id)
);
CREATE INDEX query_run_channels_channel ON m1.query_run_channels(channel_id);
CREATE TABLE m1.channel_candidates (
  workspace_id text NOT NULL, channel_id text NOT NULL CHECK (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  state text NOT NULL CHECK (state IN ('QUALIFIED','UNQUALIFIED','UNAVAILABLE','ADMITTED','REJECTED')),
  reason text CHECK (reason IN ('below_threshold','hidden_subscribers','not_found')),
  title text, country text, subscriber_count bigint, video_count bigint, view_count bigint,
  first_run_id uuid NOT NULL REFERENCES m1.query_runs(run_id), first_binding_id uuid NOT NULL REFERENCES m1.query_bindings(binding_id),
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(), checked_at timestamptz NOT NULL,
  decided_by text, decided_at timestamptz, decision_reason text CHECK (length(decision_reason) <= 300),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, channel_id)
);
CREATE INDEX channel_candidates_state ON m1.channel_candidates(workspace_id, state, discovered_at DESC);
ALTER TABLE m1.data_api_permits ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE m1.data_api_permits ADD COLUMN run_id uuid REFERENCES m1.query_runs(run_id);
ALTER TABLE m1.data_api_permits ADD CONSTRAINT data_api_permits_one_owner CHECK ((plan_id IS NULL) <> (run_id IS NULL));
