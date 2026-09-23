import { z } from 'zod';

export const CONTRACT_VERSION = 'm1.v1' as const;
export const WORKFLOW_TYPE = 'fixturePlanWorkflow' as const;
export const DEFAULT_TASK_QUEUE = 'crawlsystem-m1-main';
export const MAX_BODY_BYTES = 1_048_576;
export const WORKER_STALE_SECONDS = 90;
export const DomainSchema = z.enum(['ABOUT', 'VIDEO', 'AGENT']);
export type Domain = z.infer<typeof DomainSchema>;
export const PlanStatusSchema = z.enum(['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'CANCELLED', 'FAILED']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export const RoleSchema = z.enum(['reader', 'operator', 'worker']);
export type Role = z.infer<typeof RoleSchema>;
export interface Principal { subject: string; workspace_id: string; role: Role; }
export const LoginSchema = z.strictObject({ username: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(1).max(256) });
export type Login = z.infer<typeof LoginSchema>;
export const LogoutSchema = z.strictObject({ ok: z.literal(true) });
export const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9:_./-]+$/);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Text = z.string().max(20_000);
const Url = z.url().max(2048);
const NullableText = Text.nullable();
const UniqueDomains = z.array(DomainSchema).min(1).max(3).refine(a => new Set(a).size === a.length, 'duplicate domains');

export const MetricSchema = z.strictObject({
  value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  status: z.enum(['exact', 'estimated', 'empty', 'unavailable', 'unresolved', 'disabled']),
  source: z.string().min(1).max(120), observed_at: Timestamp,
}).refine(m => !['exact', 'estimated'].includes(m.status) || m.value !== null, 'resolved metric requires value');
export const ChannelFactsSchema = z.strictObject({
  channel_id: IdSchema, channel_url: Url, title: z.string().min(1).max(1000),
  handle: NullableText, avatar_url: Url.nullable(), summary: NullableText,
  about_description: NullableText, country: NullableText, country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
  country_source: NullableText, joined_at: z.iso.date().nullable(), joined_date_text: NullableText,
  joined_at_precision: z.enum(['date_only', 'unknown']),
  keywords: z.array(z.string().max(200)).max(100), available_tabs: z.array(z.string().max(100)).max(20),
  external_links: z.array(z.strictObject({ title: z.string().max(500), url: Url })).max(100),
  subscriber_count: MetricSchema, total_view_count: MetricSchema, total_video_count: MetricSchema,
  is_verified: z.boolean().nullable(), is_family_safe: z.boolean().nullable(),
  youtube_business_email_available: z.boolean().nullable(),
  observed_at: Timestamp, source: z.string().min(1).max(120),
});
export type ChannelFacts = z.infer<typeof ChannelFactsSchema>;
export const CommentSchema = z.strictObject({
  comment_id: IdSchema, position: z.number().int().positive(), text: Text,
  author_name: NullableText, author_channel_id: IdSchema.nullable(), author_url: Url.nullable(), author_avatar_url: Url.nullable(),
  published_at_utc: Timestamp.nullable(), published_text_raw: NullableText,
  published_at_status: z.enum(['exact', 'estimated_relative', 'unresolved']),
  is_edited: z.boolean().nullable(), like_count: z.number().int().nonnegative().nullable(), reply_count: z.number().int().nonnegative().nullable(),
  is_pinned: z.boolean().nullable(), is_channel_owner: z.boolean().nullable(), is_verified: z.boolean().nullable(), is_hearted: z.boolean().nullable(),
});
export const CommentPageSchema = z.strictObject({
  version: z.literal(1), collected_at: Timestamp, sort: z.enum(['TOP_COMMENTS', 'NEWEST_FIRST']),
  total_count: z.number().int().nonnegative().nullable(), returned_count: z.number().int().nonnegative().max(100),
  comments: z.array(CommentSchema).max(100),
}).refine(p => p.returned_count === p.comments.length && new Set(p.comments.map(c => c.comment_id)).size === p.comments.length, 'comment count/identity mismatch');
export const VideoFactsSchema = z.strictObject({
  channel_id: IdSchema, source_content_id: IdSchema, content_type: z.enum(['video', 'short', 'live']),
  content_type_source: z.string().min(1).max(120), url: Url, title: z.string().min(1).max(1000),
  description: NullableText, thumbnail_url: Url.nullable(), keywords: z.array(z.string().max(200)).max(100), hashtags: z.array(z.string().max(200)).max(100),
  published_at: Timestamp.nullable(), published_text_raw: NullableText, published_at_status: z.enum(['exact', 'relative', 'estimated', 'unavailable', 'unresolved']),
  published_at_precision: z.enum(['second', 'date_only', 'unknown']), published_at_source: z.string().min(1).max(120),
  duration_seconds: MetricSchema, view_count: MetricSchema, like_count: MetricSchema, comment_count: MetricSchema,
  comments_disabled: z.boolean().nullable(), comments_first_page: CommentPageSchema.nullable(),
  access_status: z.enum(['public', 'unlisted', 'members_only', 'private', 'unavailable', 'login_required', 'unknown']),
  access_status_source: z.string().min(1).max(120), is_members_only: z.boolean(),
  live_scheduled_at: Timestamp.nullable(), live_started_at: Timestamp.nullable(), live_ended_at: Timestamp.nullable(),
  observed_at: Timestamp, extractor_version: z.string().min(1).max(120),
}).refine(v => v.comments_disabled !== true || (v.comment_count.value === 0 && v.comment_count.status === 'disabled' && (v.comments_first_page?.returned_count ?? 0) === 0), 'disabled comments require zero/disabled and no comments');
export type VideoFacts = z.infer<typeof VideoFactsSchema>;
const percent = z.number().int().min(0).max(100);
const distribution = (label: string) => z.array(z.object({ [label]: z.string().min(1).max(100), percentage: percent })).min(1).max(20)
  .refine(a => a.reduce((sum, row) => sum + Number(row.percentage), 0) === 100, 'percentages must sum to 100');
const fact = <T extends z.ZodType>(value: T) => z.strictObject({ value, source: z.string().min(1).max(120), confidence: z.enum(['low', 'medium', 'high']), evidence: z.array(z.string().max(1000)).max(20), source_urls: z.array(Url).max(20), reason: NullableText });
export const AgentFactsSchema = z.strictObject({
  country: fact(z.string().min(1).max(100)), creator_gender: fact(z.enum(['male', 'female', 'brand_team'])),
  creator_age_range: fact(z.number().int().min(0).max(120)), creator_language: fact(z.string().min(1).max(100)),
  audience_region: fact(distribution('region')), audience_language: fact(distribution('language')),
  audience_age_gender: fact(z.array(z.strictObject({ age_range: z.enum(['18-24','25-34','35-44','45-54','55-64','65+']), male: percent, female: percent })).length(6)
    .refine(a => new Set(a.map(r => r.age_range)).size === 6 && a.reduce((sum, r) => sum + r.male + r.female, 0) === 100, 'age distribution mismatch')),
  active_subscriber_ratio: fact(percent),
  channel_tags: fact(z.strictObject({ tags: z.array(z.string().min(1).max(100)).length(10), top_5_distribution: distribution('tag') })),
  channel_categories: fact(z.strictObject({ level_1: z.string().min(1).max(100), level_2: z.array(z.string().min(1).max(100)).min(1).max(3) })),
});
export const AgentResultSchema = z.strictObject({ channel_id: IdSchema, input_hash: Hash, model_version: IdSchema, taxonomy_version: IdSchema, observed_at: Timestamp, facts: AgentFactsSchema });
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const CreatePlanSchema = z.strictObject({ request_id: z.uuid(), fixture_id: z.literal('channel-basic-v1'), required_domains: UniqueDomains.default(['ABOUT','VIDEO']) });
export type CreatePlan = z.infer<typeof CreatePlanSchema>;
export const FrozenInputSchema = z.strictObject({
  schema_version: z.literal(CONTRACT_VERSION), source_mode: z.literal('fixture'), fixture_id: z.literal('channel-basic-v1'),
  channel_id: IdSchema, required_domains: UniqueDomains, target_video_ids: z.array(IdSchema).max(100),
  reference_time: Timestamp, deadline_at: Timestamp, max_attempts: z.number().int().min(1).max(10),
  sample: z.strictObject({ about: ChannelFactsSchema, videos: z.array(VideoFactsSchema).max(100) }),
});
export type FrozenInput = z.infer<typeof FrozenInputSchema>;
const SubmissionCommon = { schema_version: z.literal(CONTRACT_VERSION), submission_id: z.uuid(), plan_id: z.uuid(), execution_epoch: z.number().int().positive(), input_hash: Hash, logical_batch_key: IdSchema, domain_complete: z.boolean(), payload_hash: Hash };
export const SubmissionSchema = z.discriminatedUnion('domain', [
  z.strictObject({ ...SubmissionCommon, domain: z.literal('ABOUT'), payload: ChannelFactsSchema }),
  z.strictObject({ ...SubmissionCommon, domain: z.literal('VIDEO'), payload: z.array(VideoFactsSchema).max(100) }),
  z.strictObject({ ...SubmissionCommon, domain: z.literal('AGENT'), payload: AgentResultSchema }),
]);
export type Submission = z.infer<typeof SubmissionSchema>;
export interface Receipt { schema_version: typeof CONTRACT_VERSION; submission_id: string; plan_id: string; logical_batch_key: string; domain: Domain; payload_hash: string; state: 'APPLIED'; applied_at: string; }
export interface DomainResult { domain: Domain; state: 'PENDING' | 'APPLIED'; completed_at: string | null; }
export interface Plan { plan_id: string; run_id: string; workspace_id: string; channel_id: string; source_revision: number; source_mode: 'fixture'; fixture_id: string; required_domains: Domain[]; status: PlanStatus; version: number; execution_epoch: number; input_hash: string; workflow_id: string; created_at: string; updated_at: string; finished_at: string | null; deadline_at: string; publication_status: 'NOT_ENABLED'; }
export interface PlanInput { plan: Plan; input: FrozenInput; domains: DomainResult[]; receipts: Receipt[]; }
export const CancelPlanSchema = z.strictObject({ command_id: z.uuid(), expected_version: z.number().int().positive() });
export const ErrorCodeSchema = z.enum(['INVALID_REQUEST','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','CONFLICT','STALE_EXECUTION','PLAN_TERMINAL','INPUT_MISMATCH','TARGET_MISMATCH','DOMAIN_INCOMPLETE','DOMAIN_NOT_REQUIRED','DEPENDENCY_NOT_IMPLEMENTED','BUDGET_EXHAUSTED','UNAVAILABLE','INTERNAL_ERROR']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export interface ApiError { error: { code: ErrorCode; message: string; retryable: boolean; correlation_id: string }; }
export const ExecutionEventSchema = z.strictObject({ event_id: z.uuid(), execution_epoch: z.number().int().positive(), worker_id: IdSchema, phase: z.string().min(1).max(80), kind: z.enum(['STARTED','PROGRESS','WAITING','ERROR','FAILED']), domain: DomainSchema.nullable(), message: z.string().max(1000), error_code: ErrorCodeSchema.optional() });
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export interface StoredEvent extends ExecutionEvent { plan_id: string; created_at: string; }
export const HeartbeatSchema = z.strictObject({ worker_id: IdSchema, server_id: IdSchema, build_version: z.string().min(1).max(120), accepting_work: z.boolean(), capacity: z.number().int().min(0).max(100), running_plan_ids: z.array(z.uuid()).max(100) });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export interface Worker extends Heartbeat { last_heartbeat_at: string; stale: boolean; proxy_status: 'NOT_CONFIGURED'; }
export interface PlanDetail extends PlanInput { events: StoredEvent[]; }
export interface ChannelSummary { channel_id: string; title: string | null; source_mode: 'fixture'; updated_at: string; latest_plan_id: string; }
export interface ChannelDetail extends ChannelSummary { about: ChannelFacts | null; videos: VideoFacts[]; agent: AgentResult | null; latest_plan: Plan; }
export interface Page<T> { items: T[]; next_cursor: string | null; }
/** Channel completeness for a workspace. Basis: whether every required domain of
 * each channel's latest plan is APPLIED. complete + partial + missing = total_channels.
 * missing_by_domain counts channels lacking that required domain (a channel may count
 * under several). Freshness buckets need an update policy, which M1 does not have. */
export interface Completeness {
  basis: 'latest_plan_required_domains'; observed_at: string; total_channels: number;
  complete: number; partial: number; missing: number;
  missing_by_domain: Record<Domain, number>; latest_channel_update_at: string | null;
  freshness: 'NOT_IMPLEMENTED';
}
export interface Session { subject: string; workspace_id: string; role: Role; contract_version: typeof CONTRACT_VERSION; }
export interface WorkflowInput { schema_version: typeof CONTRACT_VERSION; plan_id: string; workspace_id: string; execution_epoch: number; input_hash: string; workflow_id: string; }
export interface WorkflowStarter { start(input: WorkflowInput): Promise<{ workflow_id: string; run_id: string }>; cancel(workflow_id: string): Promise<void>; }
export interface FixtureWorkflowResult { plan_id: string; status: PlanStatus; }
export const ReceiptSchema: z.ZodType<Receipt> = z.strictObject({ schema_version: z.literal(CONTRACT_VERSION), submission_id: z.uuid(), plan_id: z.uuid(), logical_batch_key: IdSchema, domain: DomainSchema, payload_hash: Hash, state: z.literal('APPLIED'), applied_at: Timestamp });
export const DomainResultSchema: z.ZodType<DomainResult> = z.strictObject({ domain: DomainSchema, state: z.enum(['PENDING','APPLIED']), completed_at: Timestamp.nullable() });
export const PlanSchema: z.ZodType<Plan> = z.strictObject({
  plan_id: z.uuid(), run_id: z.uuid(), workspace_id: IdSchema, channel_id: IdSchema, source_revision: z.number().int().positive(),
  source_mode: z.literal('fixture'), fixture_id: z.string(), required_domains: UniqueDomains, status: PlanStatusSchema,
  version: z.number().int().positive(), execution_epoch: z.number().int().positive(), input_hash: Hash, workflow_id: z.string(),
  created_at: Timestamp, updated_at: Timestamp, finished_at: Timestamp.nullable(), deadline_at: Timestamp, publication_status: z.literal('NOT_ENABLED'),
});
export const PlanInputSchema: z.ZodType<PlanInput> = z.strictObject({ plan: PlanSchema, input: FrozenInputSchema, domains: z.array(DomainResultSchema).max(3), receipts: z.array(ReceiptSchema).max(300) });
export const StoredEventSchema: z.ZodType<StoredEvent> = ExecutionEventSchema.extend({ plan_id: z.uuid(), created_at: Timestamp });
export const PlanDetailSchema: z.ZodType<PlanDetail> = z.strictObject({ plan: PlanSchema, input: FrozenInputSchema, domains: z.array(DomainResultSchema).max(3), receipts: z.array(ReceiptSchema).max(300), events: z.array(StoredEventSchema).max(100) });
export const ChannelSummarySchema: z.ZodType<ChannelSummary> = z.strictObject({ channel_id: IdSchema, title: z.string().nullable(), source_mode: z.literal('fixture'), updated_at: Timestamp, latest_plan_id: z.uuid() });
export const ChannelDetailSchema: z.ZodType<ChannelDetail> = z.strictObject({ channel_id: IdSchema, title: z.string().nullable(), source_mode: z.literal('fixture'), updated_at: Timestamp, latest_plan_id: z.uuid(), about: ChannelFactsSchema.nullable(), videos: z.array(VideoFactsSchema).max(100), agent: AgentResultSchema.nullable(), latest_plan: PlanSchema });
export const WorkerSchema: z.ZodType<Worker> = HeartbeatSchema.extend({ last_heartbeat_at: Timestamp, stale: z.boolean(), proxy_status: z.literal('NOT_CONFIGURED') });
export const SessionSchema: z.ZodType<Session> = z.strictObject({ subject: IdSchema, workspace_id: IdSchema, role: RoleSchema, contract_version: z.literal(CONTRACT_VERSION) });
export const ApiErrorSchema: z.ZodType<ApiError> = z.strictObject({ error: z.strictObject({ code: ErrorCodeSchema, message: z.string(), retryable: z.boolean(), correlation_id: z.string() }) });
export const WorkflowInputSchema: z.ZodType<WorkflowInput> = z.strictObject({ schema_version: z.literal(CONTRACT_VERSION), plan_id: z.uuid(), workspace_id: IdSchema, execution_epoch: z.number().int().positive(), input_hash: Hash, workflow_id: z.string() });
const Count = z.number().int().nonnegative();
export const CompletenessSchema: z.ZodType<Completeness> = z.strictObject({
  basis: z.literal('latest_plan_required_domains'), observed_at: Timestamp, total_channels: Count,
  complete: Count, partial: Count, missing: Count,
  missing_by_domain: z.strictObject({ ABOUT: Count, VIDEO: Count, AGENT: Count }), latest_channel_update_at: Timestamp.nullable(),
  freshness: z.literal('NOT_IMPLEMENTED'),
}).refine(c => c.complete + c.partial + c.missing === c.total_channels, 'completeness buckets must sum to total');
export const pageSchema = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item).max(100), next_cursor: z.string().nullable() });
export const ApiRoutes = {
  session: '/v1/session', login: '/v1/auth/login', logout: '/v1/auth/logout', plans: '/v1/plans', channels: '/v1/channels', completeness: '/v1/overview/completeness', workers: '/v1/workers', errors: '/v1/errors',
  heartbeat: '/v1/workers/heartbeat', submissions: '/v1/submissions',
  plan: (id: string) => `/v1/plans/${encodeURIComponent(id)}`,
  input: (id: string) => `/v1/plans/${encodeURIComponent(id)}/input`,
  cancel: (id: string) => `/v1/plans/${encodeURIComponent(id)}/cancel`,
  events: (id: string) => `/v1/plans/${encodeURIComponent(id)}/events`,
  receipt: (id: string) => `/v1/receipts/${encodeURIComponent(id)}`,
  channel: (id: string) => `/v1/channels/${encodeURIComponent(id)}`,
} as const;
