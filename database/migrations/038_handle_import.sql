-- Account for handle resolution in the same daily budget and API telemetry.
ALTER TABLE control.data_api_permits ADD COLUMN import_request_id uuid;
ALTER TABLE control.data_api_permits DROP CONSTRAINT data_api_permits_one_owner;
ALTER TABLE control.data_api_permits ADD CONSTRAINT data_api_permits_one_owner CHECK (num_nonnulls(plan_id,run_id,import_request_id)=1);
CREATE TABLE control.handle_resolutions (
 workspace_id text NOT NULL,handle text NOT NULL,channel_id text,
 resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,handle),CHECK(handle=lower(handle)),
 CHECK(channel_id IS NULL OR channel_id ~ '^UC[A-Za-z0-9_-]{22}$')
);
