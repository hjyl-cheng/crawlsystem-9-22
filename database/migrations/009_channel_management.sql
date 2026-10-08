-- M3 step 1: channels under management and their update clocks.
-- A real channel enters management when its first plan completes (or by operator command);
-- paused channels keep their clocks, removed ones are left alone and never re-enter on
-- their own. Four clocks per managed channel (About, new-video discovery, recent-video
-- refresh, Agent) each hold the next normal run and, after a failure, an earlier retry that
-- does not advance the normal period. The effective next run is coalesce(retry_at, due_at).
-- Additive only, so Control builds without this change keep working against it.
ALTER TABLE m1.channels ADD COLUMN management_state text CHECK (management_state IN ('managed','paused','removed')),
  ADD COLUMN management_version integer NOT NULL DEFAULT 0 CHECK (management_version >= 0),
  ADD COLUMN management_changed_at timestamptz;
CREATE TABLE m1.channel_clocks (
  workspace_id text NOT NULL, channel_id text NOT NULL,
  clock text NOT NULL CHECK (clock IN ('ABOUT','DISCOVERY','REFRESH','AGENT')),
  due_at timestamptz NOT NULL, retry_at timestamptz,
  interval_days integer NOT NULL CHECK (interval_days BETWEEN 1 AND 365),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 60), policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  last_success_at timestamptz, last_attempt_at timestamptz, last_plan_id uuid,
  empty_runs integer NOT NULL DEFAULT 0 CHECK (empty_runs >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_id, clock),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES m1.channels(workspace_id, channel_id) ON DELETE CASCADE
);
CREATE INDEX channel_clocks_next_due ON m1.channel_clocks (workspace_id, (coalesce(retry_at, due_at)));
