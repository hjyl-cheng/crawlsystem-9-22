-- B2: bounded, incremental query collection. The business database is unchanged.
CREATE TABLE control.query_collection_scans (
  workspace_id text NOT NULL,channel_id text NOT NULL,last_plan_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('collected','unmapped','capacity')),
  scanned_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,channel_id)
);
CREATE TABLE control.query_collection_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,
  text text NOT NULL CHECK(length(text) BETWEEN 2 AND 80),country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
  language text NOT NULL CHECK(language ~ '^[a-z]{2,3}$'),category text NOT NULL,
  support_count integer NOT NULL DEFAULT 0 CHECK(support_count BETWEEN 0 AND 5),
  handled_support_count integer NOT NULL DEFAULT 0 CHECK(handled_support_count BETWEEN 0 AND 5),
  binding_id uuid REFERENCES control.query_bindings(binding_id),auto_created boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  UNIQUE(workspace_id,text,country,category)
);
CREATE INDEX query_collection_pending ON control.query_collection_candidates(workspace_id,updated_at,candidate_id)
  WHERE support_count>handled_support_count;
CREATE TABLE control.query_collection_evidence (
  candidate_id uuid NOT NULL REFERENCES control.query_collection_candidates(candidate_id) ON DELETE CASCADE,
  channel_id text NOT NULL CHECK(channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  source_type text NOT NULL CHECK(source_type IN ('CHANNEL_ABOUT','AUTO_TAG','VIDEO_TITLE')),
  video_id text CHECK(video_id ~ '^[A-Za-z0-9_-]{11}$'),created_at timestamptz NOT NULL,
  PRIMARY KEY(candidate_id,channel_id)
);
CREATE TABLE control.query_collection_days (
  workspace_id text NOT NULL,day date NOT NULL,created integer NOT NULL DEFAULT 0 CHECK(created>=0),
  woken integer NOT NULL DEFAULT 0 CHECK(woken>=0),PRIMARY KEY(workspace_id,day)
);
