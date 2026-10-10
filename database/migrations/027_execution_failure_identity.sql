-- Scope report identities to the plan; a Worker-supplied event UUID alone is not global.
CREATE FUNCTION telemetry.capture_execution_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE; code text; domain text;
BEGIN
 SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id;
 code:=coalesce(NEW.data->>'error_code',CASE WHEN NEW.data->>'kind'='FAILED' THEN 'EXECUTION_FAILED' ELSE 'EXECUTION_ERROR' END);
 domain:=coalesce(NEW.data->>'domain',NEW.data->>'phase','');
 PERFORM telemetry.emit(p.workspace_id,'event:'||NEW.plan_id||':'||NEW.event_id,jsonb_build_object('at',NEW.created_at,'source_mode',p.source_mode,
  'kind','EXECUTION','status',NEW.data->>'kind','domain',domain,'code',CASE WHEN NEW.data->>'kind' IN ('ERROR','FAILED') THEN code ELSE '' END,'plan_id',p.plan_id,'channel_id',p.channel_id));
 IF NEW.data->>'kind' IN ('ERROR','FAILED') THEN
  PERFORM telemetry.record_failure(p.workspace_id,'event:'||NEW.plan_id||':'||NEW.event_id,CASE WHEN domain='AGENT' THEN 'AGENT' ELSE 'WORKER' END,code,p.plan_id,NULL,(NEW.data->>'execution_epoch')::int,domain,'',1,NULL);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_execution_event() FROM PUBLIC;
DROP TRIGGER capture_events ON control.events;
CREATE TRIGGER capture_events AFTER INSERT ON control.events FOR EACH ROW EXECUTE FUNCTION telemetry.capture_execution_event();
