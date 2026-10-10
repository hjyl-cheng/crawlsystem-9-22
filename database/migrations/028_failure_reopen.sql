ALTER TABLE control.failure_reports ADD COLUMN payload_hash text;
CREATE OR REPLACE FUNCTION telemetry.record_failure(p_workspace text,p_report text,p_stage text,p_code text,p_plan uuid,p_run uuid,p_epoch integer,p_step text,p_unit text,p_attempts integer,p_raw jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid; sig text; channel text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('failure-report:'||p_workspace||':'||p_report));
 SELECT failure_id INTO id FROM control.failure_reports WHERE workspace_id=p_workspace AND report_id=p_report;
 IF id IS NOT NULL THEN RETURN id; END IF;
 SELECT channel_id INTO channel FROM control.plans WHERE plan_id=p_plan AND workspace_id=p_workspace;
 sig:=concat_ws(':',p_stage,p_code,coalesce(p_plan::text,p_run::text,'unowned'),coalesce(p_epoch,0),p_step,p_unit);
 INSERT INTO control.failures(workspace_id,signature,stage,code,plan_id,run_id,channel_id,execution_epoch,step,unit_id,attempts,raw,evidence_state)
  VALUES(p_workspace,sig,p_stage,p_code,p_plan,p_run,channel,p_epoch,p_step,p_unit,p_attempts,p_raw,CASE WHEN p_raw IS NULL THEN 'NONE' ELSE 'PENDING' END)
  ON CONFLICT(workspace_id,signature) DO UPDATE SET occurrences=control.failures.occurrences+1,attempts=control.failures.attempts+EXCLUDED.attempts,
   last_at=clock_timestamp(),version=control.failures.version+1,state=CASE WHEN control.failures.state='IGNORED' THEN 'IGNORED' ELSE 'OPEN' END,
   archived_at=CASE WHEN control.failures.state='IGNORED' THEN control.failures.archived_at ELSE NULL END,
   resolved_at=CASE WHEN control.failures.state='IGNORED' THEN control.failures.resolved_at ELSE NULL END,raw=coalesce(EXCLUDED.raw,control.failures.raw),
   evidence_state=CASE WHEN control.failures.evidence IS NOT NULL THEN 'SAVED' WHEN coalesce(EXCLUDED.raw,control.failures.raw) IS NOT NULL THEN 'PENDING' ELSE 'NONE' END
  RETURNING failure_id INTO id;
 INSERT INTO control.failure_reports(workspace_id,report_id,failure_id) VALUES(p_workspace,p_report,id);
 RETURN id;
END $$;
