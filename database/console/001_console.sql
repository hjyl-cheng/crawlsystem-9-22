-- Console accounts and sessions, stored in the formal `crawler` database under
-- the `console` schema. Crawl facts live in their own schema; the console role
-- only receives the grants listed at the end of this file.
--
-- Apply as the database owner (crawler_owner). The `console_app` login role is
-- created separately by an administrator because its password verifier must not
-- be committed.
CREATE SCHEMA console AUTHORIZATION crawler_owner;

CREATE TABLE console.accounts (
  username text PRIMARY KEY CHECK (username ~ '^[a-zA-Z0-9_.-]{1,64}$'),
  subject text NOT NULL UNIQUE CHECK (subject ~ '^[a-zA-Z0-9:_./-]{1,160}$'),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-zA-Z0-9:_./-]{1,160}$'),
  role text NOT NULL CHECK (role IN ('reader', 'operator')),
  password_algo text NOT NULL DEFAULT 'scrypt-n16384-r8-p1-64' CHECK (password_algo = 'scrypt-n16384-r8-p1-64'),
  password_salt text NOT NULL CHECK (password_salt ~ '^[a-f0-9]{32}$'),
  password_hash text NOT NULL CHECK (password_hash ~ '^[a-f0-9]{128}$'),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Only the SHA-256 of the opaque cookie secret is stored. Principals are read
-- from `accounts` on every request, so disabling an account or changing its
-- role takes effect immediately. Logout deletes the row.
CREATE TABLE console.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  username text NOT NULL REFERENCES console.accounts(username) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_expires ON console.sessions(expires_at);
CREATE INDEX sessions_username ON console.sessions(username);

GRANT USAGE ON SCHEMA console TO console_app;
GRANT SELECT, INSERT, UPDATE ON console.accounts TO console_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON console.sessions TO console_app;
