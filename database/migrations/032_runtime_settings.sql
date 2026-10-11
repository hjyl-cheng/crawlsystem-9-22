-- Control-plane settings only. Existing collection and legacy business tables are untouched.
CREATE TABLE control.runtime_settings (
 workspace_id text PRIMARY KEY, version integer NOT NULL CHECK(version>0), settings jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), operator text NOT NULL
);
CREATE TABLE control.runtime_settings_history (
 workspace_id text NOT NULL, command_id uuid NOT NULL, version integer NOT NULL,
 request_hash text NOT NULL, key text NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 reason text NOT NULL, operator text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,command_id), UNIQUE(workspace_id,version)
);
CREATE TABLE control.runtime_settings_consumers (
 workspace_id text NOT NULL, name text NOT NULL, version integer NOT NULL CHECK(version>=0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,name)
);
