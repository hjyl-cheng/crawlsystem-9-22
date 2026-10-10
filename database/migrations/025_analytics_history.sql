CREATE TABLE telemetry.bootstrap (workspace_id text PRIMARY KEY,completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),counts jsonb NOT NULL);
CREATE FUNCTION telemetry.capture_agent_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT ('AGENT'=ANY(NEW.required_domains)) OR NEW.status NOT IN ('COMPLETED','FAILED','CANCELLED') OR OLD.status=NEW.status THEN RETURN NEW; END IF;
 PERFORM telemetry.emit(NEW.workspace_id,'agent:'||NEW.plan_id||':'||NEW.status,
  jsonb_build_object('at',coalesce(NEW.finished_at,NEW.updated_at),'source_mode',NEW.source_mode,'kind','AGENT_TASK','domain','AGENT','status',NEW.status,
  'plan_id',NEW.plan_id,'channel_id',NEW.channel_id,'duration_ms',greatest(0,extract(epoch FROM coalesce(NEW.finished_at,NEW.updated_at)-NEW.created_at)*1000)));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_agent_task() FROM PUBLIC;
CREATE TRIGGER capture_agent_task AFTER UPDATE ON control.plans FOR EACH ROW EXECUTE FUNCTION telemetry.capture_agent_task();
CREATE FUNCTION telemetry.capture_api_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND NEW.failure IS NOT DISTINCT FROM OLD.failure THEN RETURN NEW; END IF;
 SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id;
 PERFORM telemetry.emit(NEW.workspace_id,'api:'||NEW.request_id||':'||coalesce(NEW.failure,'GRANTED'),
   jsonb_build_object('at',coalesce(NEW.failed_at,NEW.granted_at),'source_mode',coalesce(p.source_mode,'youtube'),'kind','DATA_API','domain',coalesce(NEW.endpoint,'unknown'),
    'status',CASE WHEN NEW.failure IS NULL THEN 'GRANTED' ELSE 'FAILED' END,'code',coalesce(NEW.failure,''),'plan_id',coalesce(NEW.plan_id::text,NEW.run_id::text,''),'channel_id',coalesce(p.channel_id,'')));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_api_event() FROM PUBLIC;
DROP TRIGGER capture_api ON control.data_api_permits;
CREATE TRIGGER capture_api AFTER INSERT OR UPDATE ON control.data_api_permits FOR EACH ROW EXECUTE FUNCTION telemetry.capture_api_event();
