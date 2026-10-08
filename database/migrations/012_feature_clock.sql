-- Clocks from the legacy algorithm, ported into packages/feature-clock (policy v16-rule-7).
-- Per channel it keeps the feature state, its own three clocks, the observations applied per
-- kind and the latest reason codes per kind; m1.channel_clocks stays the effective view (with an
-- operator's pinned interval applied) and gains the reason codes. Reference distributions are the
-- daily cross-channel percentiles growth is ranked against.
-- Additive only, so the build running during the rollout (and a rollback to it) keeps working.
CREATE TABLE m1.channel_feature_state (
  workspace_id text NOT NULL, channel_id text NOT NULL,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  state jsonb NOT NULL, clock jsonb, applied jsonb NOT NULL, reasons jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES m1.channels(workspace_id, channel_id) ON DELETE CASCADE
);
CREATE TABLE m1.feature_reference_distributions (
  workspace_id text NOT NULL, method_version text NOT NULL, as_of_day date NOT NULL,
  feature_name text NOT NULL, cohort_key text NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0), quantiles jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, method_version, as_of_day, feature_name, cohort_key)
);
ALTER TABLE m1.channel_clocks ADD COLUMN reasons text[] NOT NULL DEFAULT '{}';
-- First-seen videos: whether an earlier plan of the channel already applied a video.
CREATE INDEX plan_items_video ON m1.plan_items (item_id) WHERE domain = 'VIDEO';
