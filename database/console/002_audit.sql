-- Additive console-only change; no business or crawl-fact tables are changed.
CREATE TABLE console.audit_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO console.audit_installation(singleton) VALUES(true);
CREATE TABLE console.audit (
  audit_id uuid PRIMARY KEY,
  workspace_id text,
  actor text NOT NULL,
  username text,
  role text CHECK (role IN ('reader','operator')),
  kind text NOT NULL CHECK (kind IN ('LOGIN','LOGOUT','COMMAND','ACCOUNT')),
  action text NOT NULL,
  target text,
  request_id uuid,
  command_id uuid,
  occurred_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING','SUCCESS','REJECTED','FAILED')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  CHECK ((outcome='PENDING')=(finished_at IS NULL))
);
CREATE INDEX audit_workspace_time ON console.audit(workspace_id,occurred_at DESC,audit_id DESC);
CREATE INDEX audit_actor_time ON console.audit(workspace_id,actor,occurred_at DESC,audit_id DESC);
CREATE INDEX audit_login_time ON console.audit(workspace_id,occurred_at DESC) WHERE kind='LOGIN';
GRANT SELECT ON console.audit_installation TO console_app;
GRANT SELECT,INSERT ON console.audit TO console_app;
GRANT UPDATE(outcome,http_status,finished_at) ON console.audit TO console_app;
