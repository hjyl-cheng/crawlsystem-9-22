-- Channels queued for a first collection (bulk import). The scheduler admits them into plans under
-- the same limits as updates, so an import of hundreds never starts hundreds of plans at once.
-- Additive only, so the build running during the rollout keeps working.
CREATE TABLE m1.channel_imports (
  workspace_id text NOT NULL, channel_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','planned','done','failed')),
  requested_by text NOT NULL, request_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  plan_id uuid REFERENCES m1.plans(plan_id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_id)
);
CREATE INDEX channel_imports_queue ON m1.channel_imports(workspace_id, requested_at) WHERE state='queued';
CREATE INDEX channel_imports_plan ON m1.channel_imports(plan_id);
