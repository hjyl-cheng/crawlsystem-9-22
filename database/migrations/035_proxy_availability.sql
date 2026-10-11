-- Bounded hourly history of authenticated node observations. These are sample
-- ratios, not elapsed-time uptime. Historical endpoints may be removed without
-- rewriting the aggregate. No proxy endpoint or credential enters these tables.
CREATE TABLE control.proxy_availability_recording (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control.proxy_availability_recording(singleton) VALUES(true);
CREATE TABLE control.proxy_observation_streams (
  workspace_id text NOT NULL,proxy_id uuid NOT NULL,generation bigint NOT NULL,
  node_boot_id text NOT NULL,report_sequence bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,proxy_id,generation,node_boot_id),
  FOREIGN KEY(workspace_id,proxy_id) REFERENCES control.proxies(workspace_id,proxy_id) ON DELETE CASCADE
);
-- Seed only deduplication checkpoints from existing state, never history points.
INSERT INTO control.proxy_observation_streams(workspace_id,proxy_id,generation,node_boot_id,report_sequence,updated_at)
SELECT workspace_id,proxy_id,generation,node_boot_id,report_sequence,reported_at FROM control.proxy_observations;
CREATE INDEX proxy_stream_expiry ON control.proxy_observation_streams(workspace_id,updated_at);
CREATE TABLE control.proxy_availability_hourly (
  workspace_id text NOT NULL,bucket_at timestamptz NOT NULL,
  server_id text NOT NULL,provider text NOT NULL,group_name text NOT NULL,
  healthy bigint NOT NULL DEFAULT 0 CHECK(healthy>=0),degraded bigint NOT NULL DEFAULT 0 CHECK(degraded>=0),
  trial bigint NOT NULL DEFAULT 0 CHECK(trial>=0),cooldown bigint NOT NULL DEFAULT 0 CHECK(cooldown>=0),failed bigint NOT NULL DEFAULT 0 CHECK(failed>=0),
  requests bigint NOT NULL DEFAULT 0 CHECK(requests>=0),failures bigint NOT NULL DEFAULT 0 CHECK(failures>=0),
  first_report_at timestamptz NOT NULL,last_report_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,bucket_at,server_id,provider,group_name),
  CHECK(last_report_at>=first_report_at)
);
