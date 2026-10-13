-- Legacy channel lifecycle (oldsystem channelDormancy.js, videoActivityLifecycle.js): a channel without published
-- content in the last 90 days sleeps until a deterministic 30-90 day recheck, when only a Video probe runs.
CREATE TABLE control.channel_lifecycle (
  workspace_id text NOT NULL, channel_id text NOT NULL,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('active','dormant')),
  dormant_reason text CHECK (dormant_reason IN ('no_published_content_within_90_days','uploads_empty')),
  dormant_since timestamptz, dormant_recheck_day date,
  dormant_cycle integer NOT NULL DEFAULT 0 CHECK (dormant_cycle >= 0),
  dormant_last_probe_at timestamptz,
  recent_published_content_count integer NOT NULL DEFAULT 0 CHECK (recent_published_content_count >= 0),
  -- The last evaluation: inconclusive keeps the status it found.
  decision text NOT NULL CHECK (decision IN ('active','dormant','inconclusive')),
  decided_plan_id uuid, decided_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES control.channels(workspace_id, channel_id) ON DELETE CASCADE,
  CHECK ((lifecycle_status = 'dormant') = (dormant_reason IS NOT NULL AND dormant_since IS NOT NULL AND dormant_recheck_day IS NOT NULL AND dormant_cycle > 0))
);
CREATE INDEX channel_lifecycle_dormant ON control.channel_lifecycle (workspace_id, dormant_recheck_day) WHERE lifecycle_status = 'dormant';
-- The services that maintain the clocks maintain the lifecycle.
DO $$ DECLARE permission record; BEGIN
 FOR permission IN SELECT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='control' AND table_name='channel_clocks' AND grantee<>current_user AND grantee<>'PUBLIC'
 LOOP EXECUTE format('GRANT %s ON control.channel_lifecycle TO %I',permission.privilege_type,permission.grantee); END LOOP;
END $$;
