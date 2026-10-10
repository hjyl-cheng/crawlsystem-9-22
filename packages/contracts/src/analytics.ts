import {z} from 'zod';
import {RawReferenceSchema,StepManifestSchema} from './pipeline.ts';
import {ObjectStorageReferenceSchema} from './index.ts';
const Time=z.iso.datetime({offset:true});
export const FailureStateSchema=z.enum(['OPEN','RETRYING','RESOLVED','IGNORED']);
export const FailureReportSchema=z.strictObject({
  report_id:z.string().min(1).max(200).regex(/^[a-zA-Z0-9:._/-]+$/),
  stage:z.enum(['PARSER','SINK','WORKER','AGENT','SEARCH','DISPATCH']),code:z.string().regex(/^[A-Z0-9_]{1,80}$/),
  plan_id:z.uuid().nullable().default(null),run_id:z.uuid().nullable().default(null),execution_epoch:z.number().int().positive().nullable().default(null),
  step:z.string().regex(/^[A-Z0-9_-]{0,40}$/).default(''),unit_id:z.string().max(160).regex(/^[a-zA-Z0-9_.:-]*$/).default(''),
  attempts:z.number().int().min(1).max(100).default(1),raw:RawReferenceSchema.nullable().default(null),manifest:StepManifestSchema.nullable().default(null),
  source:z.strictObject({topic:z.enum(['crawl.raw','crawl.step','facts.channel','facts.video','facts.observation','facts.agent']),partition:z.number().int().nonnegative(),offset:z.string().regex(/^\d+$/)}).nullable().default(null),
});
export type FailureReport=z.infer<typeof FailureReportSchema>;
export const FailureSchema=z.object({
  failure_id:z.uuid(),workspace_id:z.string(),stage:FailureReportSchema.shape.stage,code:z.string(),plan_id:z.uuid().nullable(),run_id:z.uuid().nullable(),
  channel_id:z.string().nullable(),execution_epoch:z.number().int().nullable(),step:z.string(),unit_id:z.string(),state:FailureStateSchema,
  occurrences:z.number().int(),attempts:z.number().int(),first_at:Time,last_at:Time,retry_at:Time.nullable(),resolved_at:Time.nullable(),
  version:z.number().int(),reason:z.string().nullable(),decided_by:z.string().nullable(),retry_plan_id:z.uuid().nullable(),
  raw:RawReferenceSchema.nullable(),manifest:StepManifestSchema.nullable(),raw_object:ObjectStorageReferenceSchema.nullable(),evidence:z.object({bucket:z.literal('crawl-evidence'),key:z.string(),sha256:z.string(),bytes:z.number().int()}).nullable(),
  evidence_state:z.enum(['PENDING','SAVED','MISSING','NONE']),retryable:z.boolean(),retry_blocked_reason:z.string().nullable(),
});
export type Failure=z.infer<typeof FailureSchema>;
export const FailureCommandSchema=z.strictObject({command_id:z.uuid(),expected_version:z.number().int().positive(),action:z.enum(['retry','ignore']),reason:z.string().trim().min(3).max(300)});
export type FailureCommand=z.infer<typeof FailureCommandSchema>;
export const EvidencePreviewSchema=z.object({available:z.boolean(),sha256:z.string().nullable(),bytes:z.number(),responses:z.array(z.object({endpoint:z.string(),method:z.string(),status:z.number(),bytes:z.number(),captured_at:z.string()})),note:z.string()});
export const OpsEventSchema=z.strictObject({
  schema_version:z.literal('crawl.ops.v1'),event_id:z.string().min(1).max(200),workspace_id:z.string().min(1).max(160),at:Time,
  source_mode:z.enum(['youtube','fixture']),kind:z.string().max(40),domain:z.string().max(40),status:z.string().max(80),code:z.string().max(80),
  plan_id:z.string().max(100),channel_id:z.string().max(160),entity_id:z.string().max(160).default(''),units:z.number().nonnegative(),bytes:z.number().nonnegative(),duration_ms:z.number().nonnegative(),
  metric_total:z.number().nonnegative(),metric_missing:z.number().nonnegative(),views:z.number().nonnegative().nullable(),subscribers:z.number().nonnegative().nullable(),
  likes:z.number().nonnegative().nullable().default(null),comments:z.number().nonnegative().nullable().default(null),duration_seconds:z.number().nonnegative().nullable().default(null),
});
export type OpsEvent=z.infer<typeof OpsEventSchema>;
const Totals=z.object({collected:z.number(),videos:z.number(),about:z.number(),agent:z.number(),completed:z.number(),failed:z.number(),searches:z.number(),raw_bytes:z.number(),metric_total:z.number(),metric_missing:z.number()});
export const AnalyticsSchema=z.object({source:z.literal('clickhouse'),observed_at:Time,days:z.number(),totals:Totals,
  trend:z.array(Totals.extend({at:z.string()})),quality:z.array(z.object({domain:z.string(),status:z.string(),count:z.number(),missing:z.number(),total:z.number()})),
  failures:z.array(z.object({code:z.string(),count:z.number()})),baseline:z.number(),event_count:z.number(),last_event_at:z.string().nullable()});
export type Analytics=z.infer<typeof AnalyticsSchema>;
export const ChannelHistorySchema=z.object({source:z.literal('clickhouse'),observed_at:Time,channel_id:z.string(),days:z.number(),points:z.array(z.object({at:z.string(),kind:z.string(),domain:z.string(),status:z.string(),entity_id:z.string(),views:z.number().nullable(),subscribers:z.number().nullable(),likes:z.number().nullable(),comments:z.number().nullable(),duration_seconds:z.number().nullable()})).max(1000),limit:z.literal(1000)});
export const StorageSchema=z.object({observed_at:Time,postgres_bytes:z.number(),outbox:z.object({pending:z.number(),unarchived:z.number(),oldest_pending_at:Time.nullable()}),
  failures:z.object({open:z.number(),retrying:z.number(),evidence_pending:z.number()}),replays:z.object({pending:z.number(),failed:z.number()}),
  clickhouse:z.object({available:z.boolean(),bytes:z.number().nullable(),events:z.number().nullable(),last_event_at:z.string().nullable()}),
  retention:z.object({pg_days:z.literal(30),events_days:z.literal(180),evidence_days:z.literal(90),loki_days:z.literal(7),summaries:z.literal('long_term')}),
  maintenance:z.object({last_at:Time.nullable(),result:z.record(z.string(),z.number()).nullable()})});
