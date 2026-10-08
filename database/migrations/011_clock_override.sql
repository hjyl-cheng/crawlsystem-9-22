-- An operator may pin a channel's clock to a fixed interval, replacing the policy for that
-- channel and domain until cleared (null = automatic). Retries never wait longer than it.
-- Additive only, so Control builds without this change keep working against it.
ALTER TABLE m1.channel_clocks ADD COLUMN override_days integer CHECK (override_days BETWEEN 1 AND 365);
