-- Object deletion is state-driven; no upload-age expiry on crawl-raw.
CREATE TABLE telemetry.raw_retention (
  workspace_id text NOT NULL, object_key text NOT NULL,
  plan_id uuid REFERENCES control.plans, run_id uuid REFERENCES control.query_runs,
  execution_epoch integer, kind text NOT NULL CHECK(kind IN ('UNIT','MANIFEST','SEARCH')),
  required_refs jsonb NOT NULL, expected_bytes bigint,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DELETED','BLOCKED')),
  lease_token uuid, lease_until timestamptz, retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
  deleted_bytes bigint NOT NULL DEFAULT 0, outcome text CHECK(outcome IN ('DELETED','MISSING')),
  PRIMARY KEY(workspace_id,object_key),
  CHECK((plan_id IS NOT NULL AND run_id IS NULL AND execution_epoch IS NOT NULL) OR
        (plan_id IS NULL AND run_id IS NOT NULL AND execution_epoch IS NULL))
);
CREATE INDEX raw_retention_pending ON telemetry.raw_retention(workspace_id,created_at)
  WHERE state<>'DELETED';
CREATE INDEX raw_retention_plan ON telemetry.raw_retention(plan_id);
CREATE INDEX raw_retention_run ON telemetry.raw_retention(run_id);
-- Inherit precisely the Control API's existing telemetry-maintenance grants.
DO $$ DECLARE permission record; BEGIN
 FOR permission IN SELECT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='telemetry' AND table_name='maintenance' AND grantee<>current_user AND grantee<>'PUBLIC'
 LOOP EXECUTE format('GRANT %s ON telemetry.raw_retention TO %I',permission.privilege_type,permission.grantee); END LOOP;
END $$;
