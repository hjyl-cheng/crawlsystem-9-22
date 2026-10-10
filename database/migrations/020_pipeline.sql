-- R3: physically separate control decisions from collected facts. No data is discarded.
CREATE SCHEMA control;
CREATE SCHEMA crawl_data;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='m1' AND tablename NOT IN ('migrations','videos') LOOP
    EXECUTE format('ALTER TABLE m1.%I SET SCHEMA control',t.tablename);
  END LOOP;
END $$;
ALTER TABLE m1.videos SET SCHEMA crawl_data;
CREATE TABLE crawl_data.channels (
  workspace_id text NOT NULL, channel_id text NOT NULL, about jsonb, about_revision bigint NOT NULL DEFAULT 0,
  agent jsonb, agent_revision bigint NOT NULL DEFAULT 0, about_observed_at timestamptz, agent_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,channel_id)
);
INSERT INTO crawl_data.channels(workspace_id,channel_id,about,about_revision,agent,agent_revision,about_observed_at,agent_observed_at,updated_at)
  SELECT workspace_id,channel_id,about,about_revision,agent,agent_revision,
    (about->>'observed_at')::timestamptz,(agent->>'observed_at')::timestamptz,updated_at FROM control.channels;
ALTER TABLE control.channels DROP COLUMN about, DROP COLUMN about_revision, DROP COLUMN agent, DROP COLUMN agent_revision;
CREATE TABLE control.video_refresh_state (
  workspace_id text NOT NULL,channel_id text NOT NULL,video_id text NOT NULL,
  stats_observed_at timestamptz,change_probability double precision CHECK(change_probability BETWEEN 0 AND 1),
  PRIMARY KEY(workspace_id,channel_id,video_id)
);
INSERT INTO control.video_refresh_state SELECT workspace_id,channel_id,video_id,stats_observed_at,change_probability FROM crawl_data.videos;
ALTER TABLE crawl_data.videos DROP COLUMN stats_observed_at,DROP COLUMN change_probability,
  ADD COLUMN observed_at timestamptz,ADD COLUMN stats_observed_at timestamptz;
UPDATE crawl_data.videos SET observed_at=(data->>'observed_at')::timestamptz,
  stats_observed_at=coalesce((data->'view_count'->>'observed_at')::timestamptz,(data->>'observed_at')::timestamptz);
CREATE VIEW control.channel_overview AS SELECT c.*,
  (SELECT d.about FROM crawl_data.channels d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id) AS about,
  coalesce((SELECT d.about_revision FROM crawl_data.channels d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id),0) AS about_revision,
  (SELECT d.agent FROM crawl_data.channels d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id) AS agent,
  coalesce((SELECT d.agent_revision FROM crawl_data.channels d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id),0) AS agent_revision
  FROM control.channels c;
CREATE VIEW control.videos AS SELECT v.workspace_id,v.channel_id,v.video_id,v.source_revision,v.data,v.updated_at,
  coalesce(r.stats_observed_at,v.stats_observed_at) AS stats_observed_at,r.change_probability AS change_probability
  FROM crawl_data.videos v LEFT JOIN control.video_refresh_state r USING(workspace_id,channel_id,video_id);
CREATE TABLE control.plan_sampling_baselines (
  plan_id uuid NOT NULL REFERENCES control.plans,video_id text NOT NULL,data jsonb NOT NULL,change_probability double precision,
  PRIMARY KEY(plan_id,video_id)
);
ALTER TABLE control.plans ADD COLUMN pipeline_agent_hash text,ADD COLUMN pipeline_agent_snapshot jsonb;
CREATE TABLE control.pipeline_steps (
  plan_id uuid NOT NULL REFERENCES control.plans,execution_epoch integer NOT NULL,step text NOT NULL,
  manifest jsonb NOT NULL,manifest_hash text NOT NULL,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED')),
  last_reconciled_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,execution_epoch,step)
);
CREATE TABLE crawl_data.ingest_units (
  plan_id uuid NOT NULL,execution_epoch integer NOT NULL,step text NOT NULL,unit_id text NOT NULL,
  workspace_id text NOT NULL,raw_key text NOT NULL,raw_hash text NOT NULL,fact_hash text NOT NULL,fact jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(plan_id,execution_epoch,step,unit_id)
);
CREATE INDEX ingest_units_owner ON crawl_data.ingest_units(workspace_id,plan_id);
-- The sink may lock/check a plan without gaining UPDATE privileges on any control table.
-- The plan lock fences cancellation and epoch changes until the fact + ledger transaction commits.
CREATE FUNCTION control.lock_pipeline_plan(p_workspace text,p_plan uuid,p_epoch integer,p_hash text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE; targets jsonb;
BEGIN
  SELECT * INTO p FROM control.plans WHERE workspace_id=p_workspace AND plan_id=p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p.execution_epoch<>p_epoch THEN RAISE EXCEPTION 'STALE_EXECUTION'; END IF;
  IF p.input_hash<>p_hash OR p.frozen_input->>'pipeline_version' IS DISTINCT FROM 'r3.v1' THEN RAISE EXCEPTION 'INPUT_MISMATCH'; END IF;
  IF p.status IN ('COMPLETED','CANCELLED','FAILED') THEN RAISE EXCEPTION 'PLAN_TERMINAL'; END IF;
  IF p.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'BUDGET_EXHAUSTED'; END IF;
  SELECT manifest INTO targets FROM control.plan_video_targets WHERE plan_id=p_plan;
  RETURN to_jsonb(p)||jsonb_build_object('video_targets',targets->'video_ids');
END $$;
REVOKE ALL ON FUNCTION control.lock_pipeline_plan(text,uuid,integer,text) FROM PUBLIC;
