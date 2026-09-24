-- M2: real YouTube channel plans next to fixture plans.
ALTER TABLE m1.plans DROP CONSTRAINT plans_source_mode_check;
ALTER TABLE m1.plans ADD CONSTRAINT plans_source_mode_check CHECK (source_mode IN ('fixture','youtube'));
ALTER TABLE m1.plans ALTER COLUMN fixture_id DROP NOT NULL;
ALTER TABLE m1.plans ADD CONSTRAINT plans_fixture_id_by_mode CHECK ((source_mode = 'fixture') = (fixture_id IS NOT NULL));
-- VIDEO targets are listed during execution and frozen once per plan (first accepted manifest).
CREATE TABLE m1.plan_video_targets (
  plan_id uuid PRIMARY KEY REFERENCES m1.plans(plan_id), submission_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (octet_length(manifest::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Current Agent profile per channel, with the same revision guard as About.
ALTER TABLE m1.channels ADD COLUMN agent jsonb, ADD COLUMN agent_revision bigint NOT NULL DEFAULT 0;
