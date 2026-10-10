-- C1: immutable, finalized publication payloads. CDC watches only delivery.outbox inserts.
CREATE SCHEMA delivery;
CREATE TABLE delivery.heartbeat(id integer PRIMARY KEY CHECK(id=1),beat_at timestamptz NOT NULL);
CREATE TABLE delivery.targets (
 workspace_id text PRIMARY KEY, stream_id uuid NOT NULL UNIQUE, name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE delivery.channel_state (
 workspace_id text NOT NULL REFERENCES delivery.targets(workspace_id),channel_id text NOT NULL,
 state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,channel_id)
);
CREATE TABLE delivery.records (
 delivery_id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES delivery.targets(workspace_id),
 channel_id text NOT NULL,title text,plan_id uuid REFERENCES control.plans(plan_id),
 revision integer NOT NULL CHECK(revision>=0),status text NOT NULL CHECK(status IN ('PENDING','DELIVERED','FAILED','NOT_READY','UNCHANGED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),received_at timestamptz,error_code text,
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0),domains text[] NOT NULL DEFAULT '{}',
 shard jsonb,version_vector jsonb NOT NULL DEFAULT '{}',receipt jsonb,
 UNIQUE(workspace_id,plan_id)
);
CREATE INDEX delivery_records_pending ON delivery.records(created_at) WHERE status='PENDING';
CREATE INDEX delivery_records_workspace ON delivery.records(workspace_id,created_at DESC);
CREATE TABLE delivery.outbox (
 id uuid PRIMARY KEY,aggregatetype text NOT NULL DEFAULT 'delivery',aggregateid text NOT NULL,
 type text NOT NULL DEFAULT 'finalized',payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivery_id uuid NOT NULL REFERENCES delivery.records(delivery_id)
);
CREATE TABLE delivery.retry_commands (
 command_id uuid PRIMARY KEY,workspace_id text NOT NULL,delivery_id uuid NOT NULL REFERENCES delivery.records(delivery_id),
 request_hash text NOT NULL,actor text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE control.plans ADD COLUMN publication_status text NOT NULL DEFAULT 'NOT_ENABLED'
 CHECK(publication_status IN ('NOT_ENABLED','PENDING','DELIVERED','FAILED','NOT_READY','UNCHANGED'));
REVOKE ALL ON SCHEMA delivery FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA delivery FROM PUBLIC;
