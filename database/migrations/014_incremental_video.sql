-- Incremental Video updates (M3 step 3, legacy discovery and Recent Sampling): when a video's
-- counts were last re-read and the learned chance they change, which the sampling planner scores;
-- and per plan the counts of what the re-read found, which the clock algorithm consumes.
-- Additive only, so the build running during the rollout (and a rollback to it) keeps working.
ALTER TABLE m1.videos ADD COLUMN stats_observed_at timestamptz;
ALTER TABLE m1.videos ADD COLUMN change_probability double precision CHECK (change_probability BETWEEN 0 AND 1);
CREATE TABLE m1.plan_video_samples (
  plan_id uuid PRIMARY KEY REFERENCES m1.plans(plan_id), submission_id uuid NOT NULL,
  facts jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
