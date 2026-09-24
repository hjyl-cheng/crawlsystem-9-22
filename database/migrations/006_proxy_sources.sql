-- Subscription sources: a URL listing proxy endpoints, refreshed on a schedule.
-- New endpoints are added (optionally spread over chosen servers); endpoints missing
-- from N consecutive refreshes are retired (disabled, unassigned) and come back if
-- they reappear. Operator-disabled endpoints are never re-enabled by a source.
CREATE TABLE m1.proxy_sources (
  workspace_id text NOT NULL, source_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80), url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2048),
  protocol text NOT NULL CHECK (protocol IN ('http','https','socks5')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80), group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 80),
  country_code text CHECK (country_code ~ '^[A-Z]{2}$'), kind text NOT NULL CHECK (kind IN ('static','rotating')),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 64),
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 10 AND 1440),
  retire_after_misses integer NOT NULL CHECK (retire_after_misses BETWEEN 1 AND 20),
  server_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(server_ids) <= 20),
  enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  next_fetch_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz, etag text,
  last_fetched_at timestamptz, last_status text CHECK (last_status IN ('ok','not_modified','error')), last_error text CHECK (length(last_error) <= 200),
  last_count integer, last_added integer, last_retired integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, source_id), UNIQUE (workspace_id, url)
);
CREATE INDEX proxy_sources_due ON m1.proxy_sources(next_fetch_at) WHERE enabled;
ALTER TABLE m1.proxies ADD COLUMN source_id uuid, ADD COLUMN source_misses integer NOT NULL DEFAULT 0, ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT proxies_source FOREIGN KEY (workspace_id, source_id) REFERENCES m1.proxy_sources(workspace_id, source_id) ON DELETE SET NULL (source_id);
