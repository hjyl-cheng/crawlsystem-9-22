ALTER TABLE control.failures ADD COLUMN raw_object jsonb;
ALTER TABLE control.query_runs ADD COLUMN error_evidence jsonb;
CREATE FUNCTION telemetry.capture_search_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.state=OLD.state AND NEW.failures=OLD.failures AND NEW.last_error IS NOT DISTINCT FROM OLD.last_error THEN RETURN NEW; END IF;
 PERFORM telemetry.emit(NEW.workspace_id,'query:'||NEW.run_id||':'||NEW.state||':'||NEW.attempt||':'||NEW.failures,
   jsonb_build_object('at',coalesce(NEW.finished_at,NEW.started_at,NEW.created_at),'kind','SEARCH','status',NEW.state,'plan_id',NEW.run_id,'units',coalesce(NEW.new_channels,0)));
 IF NEW.last_error IS NOT NULL AND NEW.state IN ('PENDING','FAILED') THEN
  id:=telemetry.record_failure(NEW.workspace_id,'query:'||NEW.run_id||':'||NEW.attempt||':'||NEW.last_error,'SEARCH',upper(NEW.last_error),NULL,NEW.run_id,NULL,'','',1,NULL);
  IF NEW.error_evidence IS NOT NULL THEN UPDATE control.failures SET raw_object=NEW.error_evidence,evidence_state=CASE WHEN evidence IS NULL THEN 'PENDING' ELSE evidence_state END WHERE failure_id=id; END IF;
 END IF;
 IF NEW.state='SUCCEEDED' THEN UPDATE control.failures SET state='RESOLVED',resolved_at=clock_timestamp(),version=version+1 WHERE run_id=NEW.run_id AND state IN ('OPEN','RETRYING'); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_search_event() FROM PUBLIC;
DROP TRIGGER capture_queries ON control.query_runs;
CREATE TRIGGER capture_queries AFTER INSERT OR UPDATE ON control.query_runs FOR EACH ROW EXECUTE FUNCTION telemetry.capture_search_event();
CREATE FUNCTION telemetry.capture_error_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.data->'evidence_ref' IS NOT NULL AND NEW.data->>'kind' IN ('ERROR','FAILED') THEN
  UPDATE control.failures f SET raw_object=NEW.data->'evidence_ref',evidence_state=CASE WHEN f.evidence IS NULL THEN 'PENDING' ELSE f.evidence_state END
    FROM control.failure_reports r WHERE r.report_id='event:'||NEW.plan_id||':'||NEW.event_id AND r.failure_id=f.failure_id AND f.plan_id=NEW.plan_id AND f.execution_epoch=(NEW.data->>'execution_epoch')::int;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION telemetry.capture_error_evidence() FROM PUBLIC;
-- PostgreSQL executes same-kind triggers in name order: capture_events first registers the failure.
CREATE TRIGGER capture_z_error_evidence AFTER INSERT ON control.events FOR EACH ROW EXECUTE FUNCTION telemetry.capture_error_evidence();
