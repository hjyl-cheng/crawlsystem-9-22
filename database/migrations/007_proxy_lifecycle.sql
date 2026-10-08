-- Proxy lifecycle: a node reports `trial` until content probes qualify a proxy, and Control
-- retires endpoints that fail repeatedly on their server. The retire reason decides whether a
-- subscription may bring an endpoint back: one that disappeared returns when it reappears, an
-- unhealthy one only after a quarantine period (it then starts a new trial).
-- Additive only, so Control builds without this change keep working against the migrated schema.
ALTER TABLE m1.proxy_observations DROP CONSTRAINT proxy_observations_state_check,
  ADD CONSTRAINT proxy_observations_state_check CHECK (state IN ('trial','healthy','degraded','cooldown','failed'));
ALTER TABLE m1.proxies ADD COLUMN retire_reason text CHECK (retire_reason IN ('source_missing','unhealthy'));
UPDATE m1.proxies SET retire_reason='source_missing' WHERE retired_at IS NOT NULL;
