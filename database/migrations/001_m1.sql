CREATE SCHEMA IF NOT EXISTS m1;
CREATE TABLE IF NOT EXISTS m1.migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE m1.plans (
  plan_id uuid PRIMARY KEY, run_id uuid NOT NULL UNIQUE, workspace_id text NOT NULL,
  request_id uuid NOT NULL, request_hash text NOT NULL, channel_id text NOT NULL,
  source_revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_mode text NOT NULL CHECK (source_mode = 'fixture'), fixture_id text NOT NULL,
  required_domains text[] NOT NULL CHECK (cardinality(required_domains) BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING','COMPLETED','CANCELLED','FAILED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), execution_epoch integer NOT NULL DEFAULT 1 CHECK (execution_epoch > 0),
  frozen_input jsonb NOT NULL CHECK (octet_length(frozen_input::text) <= 1048576), input_hash text NOT NULL,
  workflow_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz, deadline_at timestamptz NOT NULL,
  UNIQUE(workspace_id, request_id)
);
CREATE INDEX plans_workspace_created ON m1.plans(workspace_id, created_at DESC, plan_id);
CREATE INDEX plans_channel ON m1.plans(workspace_id, channel_id, source_revision DESC);
CREATE TABLE m1.domains (
  plan_id uuid NOT NULL REFERENCES m1.plans(plan_id), domain text NOT NULL CHECK (domain IN ('ABOUT','VIDEO','AGENT')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPLIED')), completed_at timestamptz,
  PRIMARY KEY(plan_id, domain)
);
CREATE TABLE m1.channels (
  workspace_id text NOT NULL, channel_id text NOT NULL, latest_plan_id uuid NOT NULL REFERENCES m1.plans(plan_id),
  latest_plan_revision bigint NOT NULL, about jsonb, about_revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id, channel_id)
);
CREATE TABLE m1.videos (
  workspace_id text NOT NULL, channel_id text NOT NULL, video_id text NOT NULL, source_revision bigint NOT NULL,
  data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id, channel_id, video_id)
);
CREATE TABLE m1.receipts (
  workspace_id text NOT NULL, submission_id uuid NOT NULL, plan_id uuid NOT NULL REFERENCES m1.plans(plan_id),
  domain text NOT NULL, logical_batch_key text NOT NULL, payload_hash text NOT NULL, receipt jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id, submission_id),
  UNIQUE(plan_id, domain, logical_batch_key)
);
CREATE INDEX receipts_plan ON m1.receipts(plan_id, applied_at);
CREATE TABLE m1.plan_items (
  plan_id uuid NOT NULL REFERENCES m1.plans(plan_id), domain text NOT NULL, item_id text NOT NULL,
  submission_id uuid NOT NULL, PRIMARY KEY(plan_id, domain, item_id)
);
CREATE TABLE m1.commands (
  workspace_id text NOT NULL, command_id uuid NOT NULL, plan_id uuid NOT NULL REFERENCES m1.plans(plan_id),
  command_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id, command_id)
);
CREATE TABLE m1.intents (
  intent_id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES m1.plans(plan_id),
  kind text NOT NULL CHECK (kind IN ('START','CANCEL')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','LEASED','DONE','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz, lease_token uuid, workflow_run_id text, last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(plan_id,kind)
);
CREATE INDEX intents_pending ON m1.intents(available_at) WHERE state IN ('PENDING','LEASED');
CREATE TABLE m1.obligations (
  plan_id uuid NOT NULL REFERENCES m1.plans(plan_id), kind text NOT NULL CHECK (kind='FIXTURE_PLAN_SETTLED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(plan_id, kind)
);
CREATE TABLE m1.events (
  plan_id uuid NOT NULL REFERENCES m1.plans(plan_id), event_id uuid NOT NULL, event_hash text NOT NULL,
  data jsonb NOT NULL CHECK (octet_length(data::text) <= 4096), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id, event_id)
);
CREATE INDEX events_plan_time ON m1.events(plan_id,created_at DESC);
CREATE TABLE m1.workers (
  workspace_id text NOT NULL, worker_id text NOT NULL, heartbeat jsonb NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id, worker_id)
);
