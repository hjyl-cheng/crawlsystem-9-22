-- Fence an Agent snapshot against another plan writing the same channel concurrently.
-- All fact writers take the plan lock, then this channel lock, in the same order.
CREATE OR REPLACE FUNCTION control.lock_pipeline_plan(p_workspace text,p_plan uuid,p_epoch integer,p_hash text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE; targets jsonb;
BEGIN
  SELECT * INTO p FROM control.plans WHERE workspace_id=p_workspace AND plan_id=p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p.execution_epoch<>p_epoch THEN RAISE EXCEPTION 'STALE_EXECUTION'; END IF;
  IF p.input_hash<>p_hash OR p.frozen_input->>'pipeline_version' IS DISTINCT FROM 'r3.v1' THEN RAISE EXCEPTION 'INPUT_MISMATCH'; END IF;
  IF p.status IN ('COMPLETED','CANCELLED','FAILED') THEN RAISE EXCEPTION 'PLAN_TERMINAL'; END IF;
  IF p.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'BUDGET_EXHAUSTED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pipeline-channel:'||p.workspace_id||':'||p.channel_id));
  SELECT manifest INTO targets FROM control.plan_video_targets WHERE plan_id=p_plan;
  RETURN to_jsonb(p)||jsonb_build_object('video_targets',targets->'video_ids');
END $$;
