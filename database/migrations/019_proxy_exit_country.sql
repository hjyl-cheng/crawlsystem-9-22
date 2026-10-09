-- Exit country of each proxy as YouTube sees it (plan R2, 2026-10-09). The legacy collection
-- identity requires Brazilian egress, and imported proxies carry no reliable country. The control
-- plane checks every proxy shortly after import through the proxy itself (YouTube's sw.js_data
-- reports the detected country and the exit IP) and rechecks it periodically. `country_code`
-- stays the operator's declaration. Additive only.
ALTER TABLE m1.proxies ADD COLUMN exit_country text CHECK (exit_country ~ '^[A-Z]{2}$');
ALTER TABLE m1.proxies ADD COLUMN exit_ip text CHECK (length(exit_ip) <= 64);
ALTER TABLE m1.proxies ADD COLUMN exit_checked_at timestamptz;
ALTER TABLE m1.proxies ADD COLUMN exit_check_error text CHECK (length(exit_check_error) <= 40);
ALTER TABLE m1.proxies ADD COLUMN exit_check_failures integer NOT NULL DEFAULT 0 CHECK (exit_check_failures >= 0);
CREATE INDEX proxies_exit_check ON m1.proxies(workspace_id, exit_checked_at NULLS FIRST) WHERE retired_at IS NULL;
