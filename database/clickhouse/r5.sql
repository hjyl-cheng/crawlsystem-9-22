CREATE DATABASE IF NOT EXISTS crawl;
CREATE TABLE IF NOT EXISTS crawl.events (
 event_id String,workspace_id String,at DateTime64(3,'UTC'),source_mode LowCardinality(String),kind LowCardinality(String),
 domain LowCardinality(String),status LowCardinality(String),code LowCardinality(String),plan_id String,channel_id String,
 units Float64,bytes Float64,duration_ms Float64,metric_total Float64,metric_missing Float64,views Nullable(Float64),subscribers Nullable(Float64)
) ENGINE=ReplacingMergeTree ORDER BY (workspace_id,event_id) PARTITION BY toYYYYMM(at) TTL at + INTERVAL 180 DAY DELETE;
-- Explicitly rebuilt from deduplicated events. A summing materialized view over retried
-- inserts would count duplicates before ReplacingMergeTree's merge and is deliberately avoided.
CREATE TABLE IF NOT EXISTS crawl.hourly (
 workspace_id String,source_mode LowCardinality(String),bucket DateTime('UTC'),kind LowCardinality(String),domain LowCardinality(String),status LowCardinality(String),code LowCardinality(String),
 count UInt64,units Float64,bytes Float64,duration_ms Float64,metric_total Float64,metric_missing Float64,updated_at DateTime64(3,'UTC')
) ENGINE=ReplacingMergeTree(updated_at) ORDER BY (workspace_id,source_mode,bucket,kind,domain,status,code) PARTITION BY toYYYYMM(bucket);
CREATE TABLE IF NOT EXISTS crawl.daily AS crawl.hourly ENGINE=ReplacingMergeTree(updated_at) ORDER BY (workspace_id,source_mode,bucket,kind,domain,status,code) PARTITION BY toYYYYMM(bucket);
ALTER TABLE crawl.events ADD COLUMN IF NOT EXISTS entity_id String DEFAULT '';
ALTER TABLE crawl.events ADD COLUMN IF NOT EXISTS likes Nullable(Float64);
ALTER TABLE crawl.events ADD COLUMN IF NOT EXISTS comments Nullable(Float64);
ALTER TABLE crawl.events ADD COLUMN IF NOT EXISTS duration_seconds Nullable(Float64);
