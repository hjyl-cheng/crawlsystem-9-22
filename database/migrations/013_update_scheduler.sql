-- Durable admission and once-per-UTC-day clock attempts. Existing plans remain FULL.
ALTER TABLE m1.plans ADD COLUMN plan_kind text NOT NULL DEFAULT 'FULL' CHECK (plan_kind IN ('FULL','UPDATE'));
ALTER TABLE m1.plans ADD COLUMN update_trigger text CHECK (update_trigger IN ('SCHEDULED','MANUAL'));
ALTER TABLE m1.plans ADD COLUMN update_due_at timestamptz;
ALTER TABLE m1.channel_clocks ADD COLUMN last_scheduled_at timestamptz;
CREATE INDEX plans_updates ON m1.plans(workspace_id, channel_id, created_at DESC) WHERE plan_kind='UPDATE';
CREATE UNIQUE INDEX plans_one_active_update ON m1.plans(workspace_id,channel_id)
  WHERE plan_kind='UPDATE' AND status IN ('QUEUED','RUNNING','WAITING');
CREATE INDEX clocks_scheduler_due ON m1.channel_clocks(workspace_id,due_at,channel_id);
CREATE TABLE m1.update_scheduler_state (
  workspace_id text PRIMARY KEY, limits jsonb NOT NULL, last_scan_at timestamptz
);
-- API quota resets at midnight America/Los_Angeles, independently of UTC clock attempts.
CREATE TABLE m1.data_api_budget (
  workspace_id text NOT NULL, quota_day date NOT NULL,
  used_units integer NOT NULL DEFAULT 0 CHECK (used_units>=0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units>=0),
  PRIMARY KEY(workspace_id,quota_day)
);
CREATE TABLE m1.plan_api_reservations (
  plan_id uuid PRIMARY KEY REFERENCES m1.plans(plan_id), workspace_id text NOT NULL,
  quota_day date NOT NULL, remaining integer NOT NULL CHECK (remaining>=0),
  FOREIGN KEY(workspace_id,quota_day) REFERENCES m1.data_api_budget(workspace_id,quota_day)
);
CREATE TABLE m1.data_api_permits (
  workspace_id text NOT NULL, request_id uuid NOT NULL, plan_id uuid NOT NULL REFERENCES m1.plans(plan_id),
  quota_day date NOT NULL, granted_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,request_id)
);
