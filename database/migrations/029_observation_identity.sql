CREATE FUNCTION telemetry.capture_observation_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE payload jsonb:=NEW.fact->'payload'; metrics jsonb;
BEGIN
 IF NOT (NEW.fact ? 'kind') THEN RETURN NEW; END IF;
 IF NEW.fact->>'kind'='SAMPLING' THEN
  metrics:=jsonb_build_object('views',coalesce(payload->'items'->0->'metrics'->'view_count'->'value',payload->'items'->0->'view_count','null'),
   'likes',coalesce(payload->'items'->0->'metrics'->'like_count'->'value',payload->'items'->0->'like_count','null'),
   'comments',coalesce(payload->'items'->0->'metrics'->'comment_count'->'value',payload->'items'->0->'comment_count','null'));
 ELSE metrics:=jsonb_build_object('likes',coalesce(payload->'like_count'->'value','null'),'comments',coalesce(payload->'comment_count'->'value','null'),'duration_seconds',coalesce(payload->'duration_seconds'->'value','null')); END IF;
 UPDATE telemetry.outbox SET event=event||jsonb_build_object('entity_id',NEW.unit_id)||metrics
 WHERE source_key='unit:'||NEW.plan_id||':'||NEW.execution_epoch||':'||NEW.step||':'||NEW.unit_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_observation_identity() FROM PUBLIC;
CREATE TRIGGER capture_z_observation_identity AFTER INSERT OR UPDATE OF fact ON crawl_data.ingest_units FOR EACH ROW EXECUTE FUNCTION telemetry.capture_observation_identity();
CREATE FUNCTION telemetry.capture_plan_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telemetry.emit(NEW.workspace_id,'plan-created:'||NEW.plan_id,jsonb_build_object('at',NEW.created_at,'source_mode',NEW.source_mode,'kind','PLAN_CREATED','status','QUEUED','plan_id',NEW.plan_id,'channel_id',NEW.channel_id));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_plan_creation() FROM PUBLIC;
CREATE TRIGGER capture_plan_creation AFTER INSERT ON control.plans FOR EACH ROW EXECUTE FUNCTION telemetry.capture_plan_creation();
