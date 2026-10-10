-- Operational Kafka receipt metadata, separate from the unchanged legacy business tables.
CREATE SCHEMA IF NOT EXISTS delivery_transport;
CREATE TABLE IF NOT EXISTS delivery_transport.messages (
 delivery_id uuid PRIMARY KEY,channel_id text NOT NULL,stream_id uuid NOT NULL,
 manifest_hash text NOT NULL,metadata jsonb NOT NULL,revision_ids uuid[] NOT NULL,
 receipt_sent boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 last_received_at timestamptz NOT NULL DEFAULT now(),last_checked_at timestamptz
);
ALTER TABLE delivery_transport.messages ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS delivery_transport_pending ON delivery_transport.messages(created_at) WHERE receipt_sent=false;
REVOKE ALL ON SCHEMA delivery_transport FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA delivery_transport FROM PUBLIC;
