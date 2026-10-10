-- R4: web searches discover identities; the first durable ABOUT fact qualifies them.
-- Historical successful runs are already settled and must never be recalculated.
ALTER TABLE control.query_runs ADD COLUMN qualification_pending integer NOT NULL DEFAULT 0 CHECK (qualification_pending >= 0);
ALTER TABLE control.query_runs ADD COLUMN clock_settled_at timestamptz;
UPDATE control.query_runs SET clock_settled_at=finished_at WHERE state='SUCCEEDED';
CREATE INDEX query_runs_qualification ON control.query_runs(workspace_id,binding_id) WHERE state='SUCCEEDED' AND clock_settled_at IS NULL;
ALTER TABLE control.channel_candidates DROP CONSTRAINT channel_candidates_state_check;
ALTER TABLE control.channel_candidates ADD CONSTRAINT channel_candidates_state_check CHECK (state IN ('DISCOVERED','QUALIFIED','UNQUALIFIED','UNAVAILABLE','ADMITTED','REJECTED'));
ALTER TABLE control.channel_candidates ALTER COLUMN checked_at DROP NOT NULL;
ALTER TABLE control.channel_candidates ADD COLUMN qualification_state text CHECK (qualification_state IN ('PENDING','PASSED','REJECTED'));
ALTER TABLE control.channel_candidates ADD COLUMN min_subscribers integer CHECK (min_subscribers >= 0);
-- Source and threshold travel with the queue and frozen plan, including technical retries.
ALTER TABLE control.channel_imports ADD COLUMN discovery_qualification jsonb;
ALTER TABLE control.channel_imports DROP CONSTRAINT channel_imports_state_check;
ALTER TABLE control.channel_imports ADD CONSTRAINT channel_imports_state_check CHECK (state IN ('queued','planned','done','failed','rejected'));
CREATE TABLE control.plan_qualifications (
  plan_id uuid PRIMARY KEY REFERENCES control.plans(plan_id),
  passed boolean NOT NULL, subscriber_count bigint, reason text,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE control.query_run_pages (
  run_id uuid NOT NULL REFERENCES control.query_runs(run_id), attempt integer NOT NULL, page integer NOT NULL,
  raw_reference jsonb NOT NULL, PRIMARY KEY(run_id,attempt,page)
);
-- Extend the restricted fence result, keeping the sink unable to read control tables directly.
CREATE OR REPLACE FUNCTION control.lock_pipeline_plan(p_workspace text,p_plan uuid,p_epoch integer,p_hash text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE; targets jsonb; qualified boolean;
BEGIN
  SELECT * INTO p FROM control.plans WHERE workspace_id=p_workspace AND plan_id=p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p.execution_epoch<>p_epoch THEN RAISE EXCEPTION 'STALE_EXECUTION'; END IF;
  IF p.input_hash<>p_hash OR p.frozen_input->>'pipeline_version' IS DISTINCT FROM 'r3.v1' THEN RAISE EXCEPTION 'INPUT_MISMATCH'; END IF;
  IF p.status IN ('COMPLETED','CANCELLED','FAILED') THEN RAISE EXCEPTION 'PLAN_TERMINAL'; END IF;
  IF p.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'BUDGET_EXHAUSTED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pipeline-channel:'||p.workspace_id||':'||p.channel_id));
  SELECT manifest INTO targets FROM control.plan_video_targets WHERE plan_id=p_plan;
  SELECT passed INTO qualified FROM control.plan_qualifications WHERE plan_id=p_plan;
  RETURN to_jsonb(p)||jsonb_build_object('video_targets',targets->'video_ids','qualification_passed',coalesce(qualified,false));
END $$;
