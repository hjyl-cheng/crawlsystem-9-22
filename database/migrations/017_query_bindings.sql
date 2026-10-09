-- Discover / Query (24.8 §5): a normalised query term, bound to a country and one of the 19 fixed
-- business categories. Each binding carries its own query clock (BOOTSTRAP runs THIS_YEAR once,
-- then WEEK or MONTH; COOLDOWN / DORMANT for low yield; DISABLED by an operator) and keeps every
-- source that proposed it. Operator changes are audited. Additive only.
CREATE TABLE m1.query_terms (
  term_id uuid PRIMARY KEY, workspace_id text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, text)
);
CREATE TABLE m1.query_bindings (
  binding_id uuid PRIMARY KEY, workspace_id text NOT NULL, term_id uuid NOT NULL REFERENCES m1.query_terms(term_id),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  category text NOT NULL CHECK (category IN ('Automotive','Beauty Creators','Casual Vlogs','Dance','Education','Fashion','Food','Gaming',
    'General Humanities & Society','Health & Wellness','Home','Music','Parenting','Pets & Animals','Self Improvement','Software & Internet',
    'Sports & Outdoors','Tech','Travel')),
  state text NOT NULL DEFAULT 'BOOTSTRAP' CHECK (state IN ('BOOTSTRAP','ACTIVE','COOLDOWN','DORMANT','DISABLED')),
  cadence text CHECK (cadence IN ('WEEK','MONTH')),
  cadence_override text CHECK (cadence_override IN ('WEEK','MONTH')),
  next_run_at timestamptz, retry_at timestamptz, last_success_at timestamptz, last_run_id uuid,
  empty_runs integer NOT NULL DEFAULT 0 CHECK (empty_runs >= 0),
  priority integer NOT NULL DEFAULT 0,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, term_id, country, category)
);
CREATE INDEX query_bindings_due ON m1.query_bindings (workspace_id, next_run_at, priority DESC) WHERE state IN ('BOOTSTRAP','ACTIVE','COOLDOWN');
CREATE INDEX query_bindings_list ON m1.query_bindings (workspace_id, state, category, country);
CREATE TABLE m1.query_sources (
  binding_id uuid NOT NULL REFERENCES m1.query_bindings(binding_id),
  source_type text NOT NULL CHECK (source_type IN ('SEED_KEYWORD','AUTO_TAG','VIDEO_TITLE','VIDEO_DESCRIPTION','CHANNEL_ABOUT','RELATED_QUERY','MANUAL')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, source_type, source_ref)
);
CREATE TABLE m1.query_audit (
  binding_id uuid NOT NULL REFERENCES m1.query_bindings(binding_id), version integer NOT NULL,
  actor text NOT NULL, action text NOT NULL, detail jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, version)
);
