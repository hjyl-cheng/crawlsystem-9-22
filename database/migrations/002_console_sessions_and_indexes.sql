CREATE TABLE m1.console_sessions (
  authority text NOT NULL, session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  subject text NOT NULL, workspace_id text NOT NULL, role text NOT NULL CHECK (role IN ('reader','operator')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(authority,session_hash)
);
CREATE INDEX console_sessions_expiry ON m1.console_sessions(expires_at);
CREATE TABLE m1.console_login_limits (
  authority text NOT NULL, bucket text NOT NULL, attempts integer NOT NULL CHECK (attempts>0),
  reset_at timestamptz NOT NULL, PRIMARY KEY(authority,bucket)
);
CREATE INDEX console_login_limits_expiry ON m1.console_login_limits(reset_at);
CREATE INDEX plans_workspace_status ON m1.plans(workspace_id,status,created_at DESC,plan_id);
CREATE INDEX plans_active_deadline ON m1.plans(workspace_id,deadline_at)
  WHERE status IN ('QUEUED','RUNNING','WAITING');
CREATE INDEX channels_workspace_updated ON m1.channels(workspace_id,updated_at DESC,channel_id);
CREATE INDEX events_errors_time ON m1.events(created_at DESC,event_id,plan_id)
  WHERE data->>'kind' IN ('ERROR','FAILED');
