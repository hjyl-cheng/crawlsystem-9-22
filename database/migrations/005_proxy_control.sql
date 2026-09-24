-- M2 step 2: Proxy Control. Central inventory and coarse server assignment; the
-- node-local Proxy Manager selects per request. Credentials are AES-256-GCM
-- envelopes (key only in Control), never returned to the console.
CREATE TABLE m1.proxies (
  workspace_id text NOT NULL, proxy_id uuid NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('http','https','socks5')),
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253), port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username text CHECK (username IS NULL OR length(username) <= 256), credential text CHECK (credential IS NULL OR length(credential) <= 2048),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80), group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 80),
  country_code text CHECK (country_code ~ '^[A-Z]{2}$'), kind text NOT NULL CHECK (kind IN ('static','rotating')),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 64),
  enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Desired assignment: one server at a time; generation increases on every change.
  server_id text, generation bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, proxy_id)
);
CREATE UNIQUE INDEX proxies_endpoint ON m1.proxies(workspace_id, protocol, lower(host), port, coalesce(username, ''));
CREATE INDEX proxies_server ON m1.proxies(workspace_id, server_id) WHERE server_id IS NOT NULL;
-- Current observation per proxy (overwritten, not appended) from its assigned server.
CREATE TABLE m1.proxy_observations (
  workspace_id text NOT NULL, proxy_id uuid NOT NULL, server_id text NOT NULL, generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('healthy','degraded','cooldown','failed')), cooldown_until timestamptz,
  last_success_at timestamptz, last_failure_at timestamptz, last_error text CHECK (last_error IS NULL OR length(last_error) <= 120),
  requests_total bigint NOT NULL, failures_total bigint NOT NULL, latency_ms integer,
  node_boot_id text NOT NULL, report_sequence bigint NOT NULL, observed_at timestamptz NOT NULL, reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, proxy_id), FOREIGN KEY (workspace_id, proxy_id) REFERENCES m1.proxies(workspace_id, proxy_id) ON DELETE CASCADE
);
-- Daily counters from deltas of cumulative node counters (dedup by boot id + sequence), kept 8 days.
CREATE TABLE m1.proxy_daily (
  workspace_id text NOT NULL, proxy_id uuid NOT NULL, day date NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0), failures bigint NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (workspace_id, proxy_id, day), FOREIGN KEY (workspace_id, proxy_id) REFERENCES m1.proxies(workspace_id, proxy_id) ON DELETE CASCADE
);
