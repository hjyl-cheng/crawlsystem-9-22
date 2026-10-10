-- R5: sanitized transactional telemetry, unified failures and durable recovery commands.
CREATE SCHEMA telemetry;
CREATE TABLE telemetry.outbox (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id text NOT NULL,event jsonb NOT NULL,
  source_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,archived_at timestamptz,lease_until timestamptz
);
CREATE INDEX outbox_unarchived ON telemetry.outbox(seq) WHERE archived_at IS NULL;
CREATE TABLE control.failures (
  failure_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,signature text NOT NULL,
  stage text NOT NULL,code text NOT NULL,plan_id uuid REFERENCES control.plans,run_id uuid REFERENCES control.query_runs,
  channel_id text,execution_epoch integer,step text NOT NULL DEFAULT '',unit_id text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RETRYING','RESOLVED','IGNORED')),
  occurrences integer NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retry_at timestamptz,resolved_at timestamptz,version integer NOT NULL DEFAULT 1,reason text,decided_by text,
  retry_plan_id uuid REFERENCES control.plans,raw jsonb,evidence jsonb,archived_at timestamptz,
  evidence_state text NOT NULL DEFAULT 'NONE' CHECK(evidence_state IN ('NONE','PENDING','SAVED','MISSING')),
  UNIQUE(workspace_id,signature)
);
CREATE INDEX failures_open ON control.failures(workspace_id,state,last_at DESC);
CREATE TABLE control.failure_reports (workspace_id text NOT NULL,report_id text NOT NULL,failure_id uuid NOT NULL REFERENCES control.failures,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,report_id));
CREATE TABLE control.failure_commands (workspace_id text NOT NULL,command_id uuid NOT NULL,command_hash text NOT NULL,
  failure_id uuid NOT NULL REFERENCES control.failures,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,command_id));
CREATE TABLE control.failure_replays (
  replay_id uuid PRIMARY KEY,workspace_id text NOT NULL,failure_id uuid NOT NULL REFERENCES control.failures,
  raw jsonb NOT NULL,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DONE','FAILED','SKIPPED')),
  lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz
);
CREATE TABLE telemetry.maintenance (workspace_id text PRIMARY KEY,last_at timestamptz NOT NULL,result jsonb NOT NULL);
CREATE TABLE control.event_archive_identities (plan_id uuid NOT NULL REFERENCES control.plans,event_id uuid NOT NULL,event_hash text NOT NULL,PRIMARY KEY(plan_id,event_id));
CREATE FUNCTION telemetry.emit(p_workspace text,p_key text,p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n bigint;
BEGIN
  INSERT INTO telemetry.outbox(workspace_id,source_key,event) VALUES(p_workspace,p_key,'{}') ON CONFLICT(source_key) DO NOTHING RETURNING seq INTO n;
  IF n IS NOT NULL THEN
    UPDATE telemetry.outbox SET event=jsonb_build_object('schema_version','crawl.ops.v1','event_id',p_workspace||':'||n,'workspace_id',p_workspace,
      'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source_mode','youtube','kind','','domain','','status','','code','','plan_id','','channel_id','',
      'units',0,'bytes',0,'duration_ms',0,'metric_total',0,'metric_missing',0,'views',null,'subscribers',null)||p_event WHERE seq=n;
  END IF;
END $$;
CREATE FUNCTION telemetry.record_failure(p_workspace text,p_report text,p_stage text,p_code text,p_plan uuid,p_run uuid,p_epoch integer,p_step text,p_unit text,p_attempts integer,p_raw jsonb) RETURNS uuid
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
    ON CONFLICT(workspace_id,signature) DO UPDATE SET occurrences=control.failures.occurrences+1,
      attempts=control.failures.attempts+EXCLUDED.attempts,last_at=clock_timestamp(),version=control.failures.version+1,
      state=CASE WHEN control.failures.state='IGNORED' THEN 'IGNORED' ELSE 'OPEN' END,
      resolved_at=CASE WHEN control.failures.state='IGNORED' THEN control.failures.resolved_at ELSE NULL END,
      raw=coalesce(EXCLUDED.raw,control.failures.raw),
      evidence_state=CASE WHEN control.failures.evidence IS NOT NULL THEN 'SAVED' WHEN coalesce(EXCLUDED.raw,control.failures.raw) IS NOT NULL THEN 'PENDING' ELSE 'NONE' END
    RETURNING failure_id INTO id;
  INSERT INTO control.failure_reports(workspace_id,report_id,failure_id) VALUES(p_workspace,p_report,id);
  RETURN id;
END $$;
CREATE FUNCTION telemetry.capture_control() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE; code text; domain text; event jsonb;
BEGIN
  IF TG_TABLE_NAME='events' THEN
    SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id;
    code:=coalesce(NEW.data->>'error_code',CASE WHEN NEW.data->>'kind'='FAILED' THEN 'EXECUTION_FAILED' ELSE 'EXECUTION_ERROR' END);
    domain:=coalesce(NEW.data->>'domain',NEW.data->>'phase','');
    PERFORM telemetry.emit(p.workspace_id,'event:'||NEW.plan_id||':'||NEW.event_id,jsonb_build_object('at',NEW.created_at,'source_mode',p.source_mode,
      'kind','EXECUTION','status',NEW.data->>'kind','domain',domain,'code',CASE WHEN NEW.data->>'kind' IN ('ERROR','FAILED') THEN code ELSE '' END,'plan_id',p.plan_id,'channel_id',p.channel_id));
    IF NEW.data->>'kind' IN ('ERROR','FAILED') THEN
      PERFORM telemetry.record_failure(p.workspace_id,'event:'||NEW.event_id,CASE WHEN domain='AGENT' THEN 'AGENT' ELSE 'WORKER' END,code,p.plan_id,null,(NEW.data->>'execution_epoch')::int,domain,'',1,null);
    END IF;
  ELSIF TG_TABLE_NAME='plans' THEN
    IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NEW; END IF;
    PERFORM telemetry.emit(NEW.workspace_id,'plan:'||NEW.plan_id||':'||NEW.version,jsonb_build_object('at',NEW.updated_at,'source_mode',NEW.source_mode,
      'kind','PLAN','status',NEW.status,'plan_id',NEW.plan_id,'channel_id',NEW.channel_id,
      'duration_ms',CASE WHEN NEW.finished_at IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM NEW.finished_at-NEW.created_at)*1000) END));
    IF NEW.status='FAILED' AND NOT EXISTS(SELECT 1 FROM control.failures WHERE plan_id=NEW.plan_id AND state IN ('OPEN','RETRYING')) THEN
      PERFORM telemetry.record_failure(NEW.workspace_id,'plan:'||NEW.plan_id||':'||NEW.version,'WORKER','EXECUTION_FAILED',NEW.plan_id,null,NEW.execution_epoch,'','',1,null);
    END IF;
    IF NEW.status='COMPLETED' THEN
      UPDATE control.failures SET state='RESOLVED',resolved_at=clock_timestamp(),version=version+1 WHERE workspace_id=NEW.workspace_id
        AND (plan_id=NEW.plan_id OR retry_plan_id=NEW.plan_id) AND state IN ('OPEN','RETRYING');
    ELSIF NEW.status IN ('FAILED','CANCELLED') THEN
      UPDATE control.failures SET state='OPEN',version=version+1 WHERE retry_plan_id=NEW.plan_id AND state='RETRYING';
    END IF;
  ELSIF TG_TABLE_NAME='query_runs' THEN
    IF TG_OP='UPDATE' AND NEW.state=OLD.state AND NEW.failures=OLD.failures THEN RETURN NEW; END IF;
    PERFORM telemetry.emit(NEW.workspace_id,'query:'||NEW.run_id||':'||NEW.state||':'||NEW.attempt||':'||NEW.failures,
      jsonb_build_object('at',coalesce(NEW.finished_at,NEW.started_at,NEW.created_at),'kind','SEARCH','status',NEW.state,'plan_id',NEW.run_id,'units',coalesce(NEW.new_channels,0)));
    IF NEW.last_error IS NOT NULL AND NEW.failures>0 THEN
      code:=CASE WHEN NEW.last_error ~ '^[A-Z0-9_]{1,80}$' THEN NEW.last_error ELSE 'SEARCH_FAILED' END;
      PERFORM telemetry.record_failure(NEW.workspace_id,'query:'||NEW.run_id||':'||NEW.failures,'SEARCH',code,null,NEW.run_id,null,'','',1,null);
    END IF;
    IF NEW.state='SUCCEEDED' THEN UPDATE control.failures SET state='RESOLVED',resolved_at=clock_timestamp(),version=version+1 WHERE run_id=NEW.run_id AND state IN ('OPEN','RETRYING'); END IF;
  ELSIF TG_TABLE_NAME='data_api_permits' THEN
    IF TG_OP='UPDATE' AND NEW.failure IS NOT DISTINCT FROM OLD.failure THEN RETURN NEW; END IF;
    SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id;
    PERFORM telemetry.emit(NEW.workspace_id,'api:'||NEW.request_id||':'||coalesce(NEW.failure,'GRANTED'),
      jsonb_build_object('at',coalesce(NEW.failed_at,NEW.granted_at),'source_mode',coalesce(p.source_mode,'youtube'),'kind','DATA_API','domain',coalesce(NEW.endpoint,'unknown'),'status',CASE WHEN NEW.failure IS NULL THEN 'GRANTED' ELSE 'FAILED' END,
      'code',coalesce(NEW.failure,''),'plan_id',coalesce(NEW.plan_id::text,NEW.run_id::text,'')));
  ELSIF TG_TABLE_NAME='intents' THEN
    IF NEW.last_error IS NOT NULL AND (TG_OP='INSERT' OR NEW.last_error IS DISTINCT FROM OLD.last_error OR NEW.attempts<>OLD.attempts) THEN
      SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id;
      PERFORM telemetry.record_failure(p.workspace_id,'intent:'||NEW.intent_id||':'||NEW.attempts,'DISPATCH','DISPATCH_FAILED',p.plan_id,null,p.execution_epoch,'','',1,null);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_events AFTER INSERT ON control.events FOR EACH ROW EXECUTE FUNCTION telemetry.capture_control();
CREATE TRIGGER capture_plans AFTER INSERT OR UPDATE ON control.plans FOR EACH ROW EXECUTE FUNCTION telemetry.capture_control();
CREATE TRIGGER capture_queries AFTER INSERT OR UPDATE ON control.query_runs FOR EACH ROW EXECUTE FUNCTION telemetry.capture_control();
CREATE TRIGGER capture_api AFTER INSERT OR UPDATE ON control.data_api_permits FOR EACH ROW EXECUTE FUNCTION telemetry.capture_control();
CREATE TRIGGER capture_intents AFTER INSERT OR UPDATE ON control.intents FOR EACH ROW EXECUTE FUNCTION telemetry.capture_control();
CREATE FUNCTION telemetry.capture_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f jsonb:=NEW.fact; p control.plans%ROWTYPE; missing integer:=0; total integer:=0; key text; metric jsonb;
BEGIN
  IF NOT (f ? 'kind') THEN RETURN NEW; END IF;
  SELECT * INTO p FROM control.plans WHERE plan_id=NEW.plan_id AND workspace_id=NEW.workspace_id;
  IF f->>'kind'='ABOUT' THEN total:=3;
    FOREACH key IN ARRAY ARRAY['subscriber_count','total_view_count','total_video_count'] LOOP
      metric:=f->'payload'->key;IF metric->>'status' NOT IN ('exact','estimated','empty') OR metric->>'value' IS NULL THEN missing:=missing+1; END IF;
    END LOOP;
  ELSIF f->>'kind'='VIDEO' AND f->'payload'->>'unavailable' IS DISTINCT FROM 'true' THEN total:=4;
    FOREACH key IN ARRAY ARRAY['view_count','like_count','comment_count','duration_seconds'] LOOP
      metric:=f->'payload'->key;IF metric->>'status' NOT IN ('exact','estimated','empty','disabled') OR metric->>'value' IS NULL THEN missing:=missing+1; END IF;
    END LOOP;
  END IF;
  PERFORM telemetry.emit(NEW.workspace_id,'unit:'||NEW.plan_id||':'||NEW.execution_epoch||':'||NEW.step||':'||NEW.unit_id,
    jsonb_build_object('at',NEW.applied_at,'source_mode',coalesce(p.source_mode,'youtube'),'kind','FACT','domain',f->>'kind',
      'status',CASE WHEN f->'payload'->>'unavailable'='true' THEN 'UNAVAILABLE' WHEN missing>0 THEN 'PARTIAL' ELSE 'APPLIED' END,
      'plan_id',NEW.plan_id,'channel_id',p.channel_id,'units',1,'bytes',coalesce((f->'raw'->>'bytes')::bigint,0),'metric_total',total,'metric_missing',missing,
      'views',coalesce(f->'payload'->'view_count'->'value',f->'payload'->'total_view_count'->'value','null'),
      'subscribers',coalesce(f->'payload'->'subscriber_count'->'value','null')));
  UPDATE control.failures SET state='RESOLVED',resolved_at=clock_timestamp(),version=version+1 WHERE workspace_id=NEW.workspace_id
    AND plan_id=NEW.plan_id AND execution_epoch=NEW.execution_epoch AND step=NEW.step AND unit_id=NEW.unit_id
    AND stage IN ('PARSER','SINK') AND state IN ('OPEN','RETRYING');
  RETURN NEW;
END $$;
CREATE TRIGGER capture_fact AFTER INSERT OR UPDATE OF fact ON crawl_data.ingest_units FOR EACH ROW EXECUTE FUNCTION telemetry.capture_fact();
CREATE FUNCTION telemetry.capture_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE mode text;
BEGIN
  SELECT source_mode INTO mode FROM control.plans WHERE plan_id=NEW.plan_id;
  PERFORM telemetry.emit(NEW.workspace_id,'failure:'||NEW.failure_id||':'||NEW.version,jsonb_build_object('at',NEW.last_at,'source_mode',coalesce(mode,'youtube'),
    'kind','FAILURE','domain',NEW.stage,'status',NEW.state,'code',NEW.code,'plan_id',coalesce(NEW.plan_id::text,NEW.run_id::text,''),'channel_id',coalesce(NEW.channel_id,'')));
  RETURN NEW;
END $$;
CREATE TRIGGER capture_failure AFTER INSERT OR UPDATE ON control.failures FOR EACH ROW EXECUTE FUNCTION telemetry.capture_failure();
CREATE FUNCTION telemetry.compact_unit(p_workspace text,p_plan uuid,p_epoch integer,p_step text,p_unit text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p control.plans%ROWTYPE;
BEGIN
 SELECT * INTO p FROM control.plans WHERE workspace_id=p_workspace AND plan_id=p_plan FOR UPDATE;
 IF NOT FOUND OR p.status NOT IN ('COMPLETED','CANCELLED','FAILED') OR p.finished_at>clock_timestamp()-interval '30 days' THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM control.failures WHERE (plan_id=p_plan OR retry_plan_id=p_plan) AND state IN ('OPEN','RETRYING')) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM telemetry.outbox WHERE source_key='unit:'||p_plan||':'||p_epoch||':'||p_step||':'||p_unit AND archived_at IS NOT NULL) THEN RETURN; END IF;
 UPDATE crawl_data.ingest_units SET fact=jsonb_build_object('archived',true) WHERE plan_id=p_plan AND execution_epoch=p_epoch AND step=p_step AND unit_id=p_unit AND workspace_id=p_workspace;
END $$;
-- No direct telemetry or Control privilege is granted to the fact writer. Trigger functions
-- own their narrowly scoped work and cannot be called by a service as a general SQL gateway.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA telemetry FROM PUBLIC;
