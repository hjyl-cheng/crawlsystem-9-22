#!/usr/bin/env bash
set -euo pipefail
P=$(kubectl -n db get cluster crawler-pg -o jsonpath='{.status.currentPrimary}')
[[ -n $P ]] || exit 2
kubectl -n db exec -i "$P" -- psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE temporal OWNER temporal_svc' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='temporal') \gexec
SELECT 'CREATE DATABASE temporal_visibility OWNER temporal_svc' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='temporal_visibility') \gexec
SELECT 'CREATE DATABASE infra_smoke OWNER crawler_owner' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='infra_smoke') \gexec
REVOKE CONNECT ON DATABASE crawler, temporal, temporal_visibility, infra_smoke FROM PUBLIC;
GRANT CONNECT ON DATABASE temporal,temporal_visibility TO temporal_svc;
GRANT CONNECT ON DATABASE infra_smoke TO dbz_svc,crawler_owner;
GRANT CONNECT ON DATABASE crawler TO crawler_owner;
SQL
kubectl -n db exec -i "$P" -- psql -X -U postgres -d infra_smoke -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS publication AUTHORIZATION crawler_owner;
CREATE TABLE IF NOT EXISTS publication.outbox(
 id uuid PRIMARY KEY, aggregatetype text NOT NULL, aggregateid text NOT NULL,
 type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE publication.outbox OWNER TO crawler_owner;
GRANT USAGE ON SCHEMA publication TO dbz_svc;
GRANT SELECT ON publication.outbox TO dbz_svc;
-- Debezium heartbeat target: in the publication so heartbeats advance the slot,
-- but not in table.include.list, so it never reaches the outbox topic.
CREATE TABLE IF NOT EXISTS publication.debezium_heartbeat(id smallint PRIMARY KEY CHECK (id = 1), beat_at timestamptz NOT NULL);
ALTER TABLE publication.debezium_heartbeat OWNER TO crawler_owner;
GRANT SELECT, INSERT, UPDATE ON publication.debezium_heartbeat TO dbz_svc;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_publication WHERE pubname='infra_outbox_pub') THEN
   CREATE PUBLICATION infra_outbox_pub FOR TABLE publication.outbox, publication.debezium_heartbeat;
 ELSIF NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='infra_outbox_pub' AND tablename='debezium_heartbeat') THEN
   ALTER PUBLICATION infra_outbox_pub ADD TABLE publication.debezium_heartbeat;
 END IF;
END $$;
SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname='infra_outbox_pub';
SQL
# Assert publication was not broadened by an older setup.
COUNT=$(kubectl -n db exec "$P" -- psql -XAt -U postgres -d infra_smoke -c "SELECT count(*) FROM pg_publication_tables WHERE pubname='infra_outbox_pub'")
[[ $COUNT == 2 ]] || { echo 'Unexpected publication tables (expected outbox + heartbeat), stop'; exit 2; }
echo 'Dedicated infra_smoke database prepared. No business schema has been created.'
