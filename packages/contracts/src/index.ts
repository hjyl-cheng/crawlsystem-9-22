import { z } from 'zod';

export const CONTRACT_VERSION = 'm1.v1' as const;
// One Workflow for every plan; it branches on the frozen input's source_mode.
export const WORKFLOW_TYPE = 'channelPlanWorkflow' as const;
export const DEFAULT_TASK_QUEUE = 'crawlsystem-m1-main';
export const MAX_BODY_BYTES = 1_048_576;
export const WORKER_STALE_SECONDS = 90;
export const DomainSchema = z.enum(['ABOUT', 'VIDEO', 'AGENT']);
export type Domain = z.infer<typeof DomainSchema>;
export const SourceModeSchema = z.enum(['fixture', 'youtube']);
export type SourceMode = z.infer<typeof SourceModeSchema>;
/** Canonical YouTube channel ID; handles and vanity URLs are resolved before planning. */
export const YoutubeChannelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
export const YoutubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const PlanStatusSchema = z.enum(['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'CANCELLED', 'FAILED']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
// node: a per-server Proxy Manager (DaemonSet); its credential names the server it runs on.
export const RoleSchema = z.enum(['reader', 'operator', 'worker', 'node']);
export type Role = z.infer<typeof RoleSchema>;
export interface Principal { subject: string; workspace_id: string; role: Role; server_id?: string; }
export const LoginSchema = z.strictObject({ username: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(1).max(256) });
export type Login = z.infer<typeof LoginSchema>;
export const LogoutSchema = z.strictObject({ ok: z.literal(true) });
export const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9:_./-]+$/);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// W3C traceparent of the creating request; diagnostic context only.
export const TraceparentSchema = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
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
/** A frozen target that exists in the listing but whose details cannot be collected.
 * It settles the target explicitly; it is never counted as collected video data. */
export const VideoUnavailableSchema = z.strictObject({
  channel_id: IdSchema, source_content_id: IdSchema, unavailable: z.literal(true),
  access_status: z.enum(['private', 'removed', 'members_only', 'login_required', 'age_restricted', 'region_blocked', 'unavailable', 'unknown']),
  reason: z.string().min(1).max(1000), source: z.string().min(1).max(120), observed_at: Timestamp,
});
export type VideoUnavailable = z.infer<typeof VideoUnavailableSchema>;
export const VideoItemSchema = z.union([VideoFactsSchema, VideoUnavailableSchema]);
export type VideoItem = z.infer<typeof VideoItemSchema>;
export const isVideoUnavailable = (item: VideoItem): item is VideoUnavailable => 'unavailable' in item && item.unavailable === true;
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
/** Profile Agent response (apps/profile-agent): the profile before it is bound to one plan's input. */
export const AgentProfileSchema = z.strictObject({ model_version: IdSchema, taxonomy_version: IdSchema, observed_at: Timestamp, facts: AgentFactsSchema, diagnostics: z.array(z.string().max(120)).max(50) });
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Frozen collection scope. Defaults follow the previous system: 30 recent uploads within
 * 90 days of reference_time, first page of Top comments (at most 20) per video. */
export const CollectionScopeSchema = z.strictObject({
  video_limit: z.number().int().min(1).max(100).default(30),
  max_age_days: z.number().int().min(1).max(3650).default(90),
  comments_per_video: z.number().int().min(0).max(100).default(20),
  comment_sort: z.literal('TOP_COMMENTS').default('TOP_COMMENTS'),
});
export type CollectionScope = z.infer<typeof CollectionScopeSchema>;
const FixtureCreateSchema = z.strictObject({ request_id: z.uuid(), fixture_id: z.literal('channel-basic-v1'), required_domains: UniqueDomains.default(['ABOUT','VIDEO']) });
const YoutubeCreateSchema = z.strictObject({ request_id: z.uuid(), source_mode: z.literal('youtube'), channel_id: YoutubeChannelIdSchema,
  required_domains: UniqueDomains.default(['ABOUT','VIDEO','AGENT']), scope: CollectionScopeSchema.default(CollectionScopeSchema.parse({})) })
  .refine(p => !p.required_domains.includes('AGENT') || (p.required_domains.includes('ABOUT') && p.required_domains.includes('VIDEO')), 'AGENT requires ABOUT and VIDEO as its input');
export const CreatePlanSchema = z.union([FixtureCreateSchema, YoutubeCreateSchema]);
export type CreatePlan = z.infer<typeof CreatePlanSchema>;
const FixtureFrozenSchema = z.strictObject({
  schema_version: z.literal(CONTRACT_VERSION), source_mode: z.literal('fixture'), fixture_id: z.literal('channel-basic-v1'),
  channel_id: IdSchema, required_domains: UniqueDomains, target_video_ids: z.array(IdSchema).max(100),
  reference_time: Timestamp, deadline_at: Timestamp, max_attempts: z.number().int().min(1).max(10),
  sample: z.strictObject({ about: ChannelFactsSchema, videos: z.array(VideoFactsSchema).max(100) }),
});
const YoutubeFrozenSchema = z.strictObject({
  schema_version: z.literal(CONTRACT_VERSION), source_mode: z.literal('youtube'), channel_id: YoutubeChannelIdSchema,
  required_domains: UniqueDomains, scope: z.strictObject({ video_limit: z.number().int().min(1).max(100), max_age_days: z.number().int().min(1).max(3650),
    comments_per_video: z.number().int().min(0).max(100), comment_sort: z.literal('TOP_COMMENTS') }),
  reference_time: Timestamp, deadline_at: Timestamp, max_attempts: z.number().int().min(1).max(10),
});
export const FrozenInputSchema = z.discriminatedUnion('source_mode', [FixtureFrozenSchema, YoutubeFrozenSchema]);
export type FrozenInput = z.infer<typeof FrozenInputSchema>;
export type FixtureFrozenInput = z.infer<typeof FixtureFrozenSchema>;
export type YoutubeFrozenInput = z.infer<typeof YoutubeFrozenSchema>;
/** VIDEO targets listed once per plan. Store freezes the first accepted manifest; an
 * empty list is a legal result for a channel with no uploads in the window. */
export const VideoTargetManifestSchema = z.strictObject({
  kind: z.literal('targets'), channel_id: IdSchema, video_ids: z.array(IdSchema).max(100), listed_at: Timestamp,
  window_start: Timestamp, exhausted: z.boolean(), source: z.string().min(1).max(120),
}).refine(m => new Set(m.video_ids).size === m.video_ids.length, 'duplicate video targets');
export type VideoTargetManifest = z.infer<typeof VideoTargetManifestSchema>;
export const VideoBatchSchema = z.strictObject({ kind: z.literal('videos'), items: z.array(VideoItemSchema).max(10) })
  .refine(b => new Set(b.items.map(i => i.source_content_id)).size === b.items.length, 'duplicate video identities');
/** Agent input snapshot: this plan's channel facts and available target videos, as stored now. */
export interface AgentInput { plan_id: string; channel_id: string; about: ChannelFacts; videos: VideoFacts[]; input_hash: string; }
export const AgentInputSchema: z.ZodType<AgentInput> = z.strictObject({ plan_id: z.uuid(), channel_id: IdSchema, about: ChannelFactsSchema, videos: z.array(VideoFactsSchema).max(100), input_hash: Hash });
const SubmissionCommon = { schema_version: z.literal(CONTRACT_VERSION), submission_id: z.uuid(), plan_id: z.uuid(), execution_epoch: z.number().int().positive(), input_hash: Hash, logical_batch_key: IdSchema, domain_complete: z.boolean(), payload_hash: Hash };
export const SubmissionSchema = z.discriminatedUnion('domain', [
  z.strictObject({ ...SubmissionCommon, domain: z.literal('ABOUT'), payload: ChannelFactsSchema }),
  z.strictObject({ ...SubmissionCommon, domain: z.literal('VIDEO'), payload: z.union([VideoTargetManifestSchema, VideoBatchSchema]) }),
  z.strictObject({ ...SubmissionCommon, domain: z.literal('AGENT'), payload: AgentResultSchema }),
]);
export type Submission = z.infer<typeof SubmissionSchema>;
export interface Receipt { schema_version: typeof CONTRACT_VERSION; submission_id: string; plan_id: string; logical_batch_key: string; domain: Domain; payload_hash: string; state: 'APPLIED'; applied_at: string; }
export interface DomainResult { domain: Domain; state: 'PENDING' | 'APPLIED'; completed_at: string | null; }
export interface Plan { plan_id: string; run_id: string; workspace_id: string; channel_id: string; source_revision: number; source_mode: SourceMode; fixture_id: string | null; required_domains: Domain[]; status: PlanStatus; version: number; execution_epoch: number; input_hash: string; workflow_id: string; created_at: string; updated_at: string; finished_at: string | null; deadline_at: string; publication_status: 'NOT_ENABLED'; }
export interface PlanInput { plan: Plan; input: FrozenInput; domains: DomainResult[]; receipts: Receipt[]; trace_context?: string; video_targets?: string[]; }
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
export interface ChannelSummary { channel_id: string; title: string | null; source_mode: SourceMode; updated_at: string; latest_plan_id: string; }
/** A channel row for list pages: the summary plus current facts cheap to read in one query. */
export interface ChannelListItem extends ChannelSummary { country: string | null; subscriber_count: number | null; stored_videos: number; latest_plan_status: PlanStatus; }
export interface ChannelDetail extends ChannelSummary { about: ChannelFacts | null; videos: VideoItem[]; agent: AgentResult | null; latest_plan: Plan; }
export interface Page<T> { items: T[]; next_cursor: string | null; }
/** Workspace-wide plan statistics for the full-collection page. Counts are over
 * all plans unless named *_24h (rolling 24 hours at the server clock). domains
 * count plans that
 * require the domain and how many of those have it APPLIED; waiting_reasons group
 * WAITING plans by the phase of their latest WAITING/ERROR event. */
export interface PlansSummary {
  observed_at: string; total: number; by_status: Record<PlanStatus, number>;
  created_24h: number; completed_24h: number; avg_completion_seconds_24h: number | null;
  domains: { domain: Domain; required: number; applied: number }[];
  waiting_reasons: { reason: string; plans: number }[];
}
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
/** server_id is present for workload credentials (Worker, Proxy Manager): the node named by TokenReview. */
export interface Session { subject: string; workspace_id: string; role: Role; server_id?: string; contract_version: typeof CONTRACT_VERSION; }
export interface WorkflowInput { schema_version: typeof CONTRACT_VERSION; plan_id: string; workspace_id: string; execution_epoch: number; input_hash: string; workflow_id: string; }
export interface WorkflowStarter { start(input: WorkflowInput): Promise<{ workflow_id: string; run_id: string }>; cancel(workflow_id: string): Promise<void>; }
export interface PlanWorkflowResult { plan_id: string; status: PlanStatus; }
export const ReceiptSchema: z.ZodType<Receipt> = z.strictObject({ schema_version: z.literal(CONTRACT_VERSION), submission_id: z.uuid(), plan_id: z.uuid(), logical_batch_key: IdSchema, domain: DomainSchema, payload_hash: Hash, state: z.literal('APPLIED'), applied_at: Timestamp });
export const DomainResultSchema: z.ZodType<DomainResult> = z.strictObject({ domain: DomainSchema, state: z.enum(['PENDING','APPLIED']), completed_at: Timestamp.nullable() });
export const PlanSchema: z.ZodType<Plan> = z.strictObject({
  plan_id: z.uuid(), run_id: z.uuid(), workspace_id: IdSchema, channel_id: IdSchema, source_revision: z.number().int().positive(),
  source_mode: SourceModeSchema, fixture_id: z.string().nullable(), required_domains: UniqueDomains, status: PlanStatusSchema,
  version: z.number().int().positive(), execution_epoch: z.number().int().positive(), input_hash: Hash, workflow_id: z.string(),
  created_at: Timestamp, updated_at: Timestamp, finished_at: Timestamp.nullable(), deadline_at: Timestamp, publication_status: z.literal('NOT_ENABLED'),
});
export const PlanInputSchema: z.ZodType<PlanInput> = z.strictObject({ plan: PlanSchema, input: FrozenInputSchema, domains: z.array(DomainResultSchema).max(3), receipts: z.array(ReceiptSchema).max(300), trace_context: TraceparentSchema.optional(), video_targets: z.array(IdSchema).max(100).optional() });
export const StoredEventSchema: z.ZodType<StoredEvent> = ExecutionEventSchema.extend({ plan_id: z.uuid(), created_at: Timestamp });
export const PlanDetailSchema: z.ZodType<PlanDetail> = z.strictObject({ plan: PlanSchema, input: FrozenInputSchema, domains: z.array(DomainResultSchema).max(3), receipts: z.array(ReceiptSchema).max(300), trace_context: TraceparentSchema.optional(), video_targets: z.array(IdSchema).max(100).optional(), events: z.array(StoredEventSchema).max(100) });
export const ChannelSummarySchema: z.ZodType<ChannelSummary> = z.strictObject({ channel_id: IdSchema, title: z.string().nullable(), source_mode: SourceModeSchema, updated_at: Timestamp, latest_plan_id: z.uuid() });
export const ChannelDetailSchema: z.ZodType<ChannelDetail> = z.strictObject({ channel_id: IdSchema, title: z.string().nullable(), source_mode: SourceModeSchema, updated_at: Timestamp, latest_plan_id: z.uuid(), about: ChannelFactsSchema.nullable(), videos: z.array(VideoItemSchema).max(100), agent: AgentResultSchema.nullable(), latest_plan: PlanSchema });
export const ChannelListItemSchema: z.ZodType<ChannelListItem> = z.strictObject({ channel_id: IdSchema, title: z.string().nullable(), source_mode: SourceModeSchema, updated_at: Timestamp, latest_plan_id: z.uuid(), country: z.string().max(200).nullable(), subscriber_count: z.number().int().nonnegative().nullable(), stored_videos: z.number().int().nonnegative(), latest_plan_status: PlanStatusSchema });
export const WorkerSchema: z.ZodType<Worker> = HeartbeatSchema.extend({ last_heartbeat_at: Timestamp, stale: z.boolean(), proxy_status: z.literal('NOT_CONFIGURED') });
export const SessionSchema: z.ZodType<Session> = z.strictObject({ subject: IdSchema, workspace_id: IdSchema, role: RoleSchema, server_id: IdSchema.optional(), contract_version: z.literal(CONTRACT_VERSION) });
// Kubernetes ServiceAccount token exchange: subject is the Pod, server_id the node reported by TokenReview.
// Temporal namespace token for the gRPC Authorization header; permissions name one namespace and role.
export const TemporalTokenSchema = z.strictObject({ token: z.string().min(20).max(4096), permissions: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}:(read|write|worker)$/)).min(1).max(4), expires_in: z.number().int().min(60).max(3600) });
export const WorkloadTokenSchema = z.strictObject({ token: z.string().min(20).max(4096), subject: IdSchema, workspace_id: IdSchema, role: z.enum(['worker', 'node']), server_id: IdSchema, expires_in: z.number().int().min(60).max(3600) });
export const ApiErrorSchema: z.ZodType<ApiError> = z.strictObject({ error: z.strictObject({ code: ErrorCodeSchema, message: z.string(), retryable: z.boolean(), correlation_id: z.string() }) });
export const WorkflowInputSchema: z.ZodType<WorkflowInput> = z.strictObject({ schema_version: z.literal(CONTRACT_VERSION), plan_id: z.uuid(), workspace_id: IdSchema, execution_epoch: z.number().int().positive(), input_hash: Hash, workflow_id: z.string() });
const Count = z.number().int().nonnegative();
export const CompletenessSchema: z.ZodType<Completeness> = z.strictObject({
  basis: z.literal('latest_plan_required_domains'), observed_at: Timestamp, total_channels: Count,
  complete: Count, partial: Count, missing: Count,
  missing_by_domain: z.strictObject({ ABOUT: Count, VIDEO: Count, AGENT: Count }), latest_channel_update_at: Timestamp.nullable(),
  freshness: z.literal('NOT_IMPLEMENTED'),
}).refine(c => c.complete + c.partial + c.missing === c.total_channels, 'completeness buckets must sum to total');
export const PlansSummarySchema: z.ZodType<PlansSummary> = z.strictObject({
  observed_at: Timestamp, total: Count,
  by_status: z.strictObject({ QUEUED: Count, RUNNING: Count, WAITING: Count, COMPLETED: Count, CANCELLED: Count, FAILED: Count }),
  created_24h: Count, completed_24h: Count, avg_completion_seconds_24h: z.number().nonnegative().nullable(),
  domains: z.array(z.strictObject({ domain: DomainSchema, required: Count, applied: Count })).max(3),
  waiting_reasons: z.array(z.strictObject({ reason: z.string().min(1).max(80), plans: Count })).max(6),
}).refine(s=>Object.values(s.by_status).reduce((a,b)=>a+b,0)===s.total,'status counts must sum to total')
  .refine(s=>s.domains.every(d=>d.applied<=d.required)&&new Set(s.domains.map(d=>d.domain)).size===s.domains.length,'domain counts must be distinct and applied cannot exceed required');
/** Console accounts of the caller's workspace, for the user management page. Never
 * carries password material. Session figures come from sessions still stored:
 * logout deletes a session, so `latest_session_at` is the newest retained login,
 * not a full login history. Null means the account source cannot tell. */
export interface ConsoleAccount {
  username: string; subject: string; role: 'reader' | 'operator'; status: 'ACTIVE' | 'DISABLED';
  created_at: string | null; updated_at: string | null; active_sessions: number | null; latest_session_at: string | null;
}
export interface ConsoleAccountList { observed_at: string; source: 'DATABASE' | 'FILE' | 'MEMORY'; items: ConsoleAccount[] }
export const ConsoleAccountSchema: z.ZodType<ConsoleAccount> = z.strictObject({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/), subject: IdSchema, role: z.enum(['reader', 'operator']), status: z.enum(['ACTIVE', 'DISABLED']),
  created_at: Timestamp.nullable(), updated_at: Timestamp.nullable(), active_sessions: Count.nullable(), latest_session_at: Timestamp.nullable(),
});
export const ConsoleAccountListSchema: z.ZodType<ConsoleAccountList> = z.strictObject({
  observed_at: Timestamp, source: z.enum(['DATABASE', 'FILE', 'MEMORY']), items: z.array(ConsoleAccountSchema).max(500),
});
export const pageSchema = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item).max(100), next_cursor: z.string().nullable() });
export const ApiRoutes = {
  session: '/v1/session', login: '/v1/auth/login', logout: '/v1/auth/logout', plans: '/v1/plans', channels: '/v1/channels', completeness: '/v1/overview/completeness', plansSummary: '/v1/overview/plans', consoleAccounts: '/v1/console/accounts', workers: '/v1/workers', errors: '/v1/errors',
  heartbeat: '/v1/workers/heartbeat', submissions: '/v1/submissions', proxies: '/v1/proxies', proxyImport: '/v1/proxies/import', proxySync: '/v1/proxy-manager/sync', proxySources: '/v1/proxy-sources',
  proxySource: (id: string) => `/v1/proxy-sources/${encodeURIComponent(id)}`,
  proxy: (id: string) => `/v1/proxies/${encodeURIComponent(id)}`, proxyDelete: (id: string) => `/v1/proxies/${encodeURIComponent(id)}/delete`, workloadToken: '/v1/workload/token', temporalToken: '/v1/workload/temporal-token',
  plan: (id: string) => `/v1/plans/${encodeURIComponent(id)}`,
  input: (id: string) => `/v1/plans/${encodeURIComponent(id)}/input`,
  agentInput: (id: string) => `/v1/plans/${encodeURIComponent(id)}/agent-input`,
  cancel: (id: string) => `/v1/plans/${encodeURIComponent(id)}/cancel`,
  events: (id: string) => `/v1/plans/${encodeURIComponent(id)}/events`,
  receipt: (id: string) => `/v1/receipts/${encodeURIComponent(id)}`,
  channel: (id: string) => `/v1/channels/${encodeURIComponent(id)}`,
} as const;

// ---- Proxy Control (M2 step 2): central inventory and coarse assignment; the
// node-local Proxy Manager does per-request selection, concurrency and cooldown.
// trial: assigned but not yet qualified by content probes, so not leased to Workers.
export const ProxyStateSchema = z.enum(['healthy', 'trial', 'degraded', 'cooldown', 'failed', 'disabled', 'unassigned', 'unknown']);
export type ProxyState = z.infer<typeof ProxyStateSchema>;
const Host = z.string().min(1).max(253).regex(/^[A-Za-z0-9.:\[\]-]+$/);
const GroupName = z.string().trim().min(1).max(80);
/** Operator import row. Credentials are write-only: accepted here, never returned to the console. */
export const ProxyImportEntrySchema = z.strictObject({
  protocol: z.enum(['http', 'https', 'socks5']), host: Host, port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256).nullable().default(null), password: z.string().min(1).max(512).nullable().default(null),
  provider: GroupName, group: GroupName, country_code: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  kind: z.enum(['static', 'rotating']).default('static'), max_concurrency: z.number().int().min(1).max(64).default(2),
});
export const ProxyImportSchema = z.strictObject({ entries: z.array(ProxyImportEntrySchema).min(1).max(500) });
export type ProxyImport = z.infer<typeof ProxyImportSchema>;
/** Why Control retired an endpoint: gone from its subscription, or failed repeatedly on its server. */
export type ProxyRetireReason = 'source_missing' | 'unhealthy';
export interface ProxyView {
  proxy_id: string; protocol: 'http' | 'https' | 'socks5'; host: string; port: number; username: string | null; has_password: boolean;
  provider: string; group: string; country_code: string | null; kind: 'static' | 'rotating'; max_concurrency: number; enabled: boolean; version: number;
  server_id: string | null; source: string | null; retired: boolean; retire_reason: ProxyRetireReason | null; tls_insecure: boolean; state: ProxyState; cooldown_until: string | null; last_success_at: string | null; last_failure_at: string | null; last_error: string | null;
  requests_today: number; failures_today: number; latency_ms: number | null; observed_at: string | null; created_at: string; updated_at: string;
}
export interface ProxyOverview {
  observed_at: string; items: ProxyView[]; items_total: number;
  by_state: Record<ProxyState, number>; providers: { name: string; count: number; requests_today: number; failures_today: number }[];
  groups: { name: string; count: number }[]; requests_today: number; failures_today: number;
  availability_7d: { day: string; requests: number; failures: number }[];
}
const NullableTime = Timestamp.nullable();
export const ProxyViewSchema: z.ZodType<ProxyView> = z.strictObject({
  proxy_id: z.uuid(), protocol: z.enum(['http', 'https', 'socks5']), host: Host, port: z.number().int(), username: z.string().nullable(), has_password: z.boolean(),
  provider: z.string(), group: z.string(), country_code: z.string().nullable(), kind: z.enum(['static', 'rotating']), max_concurrency: z.number().int(), enabled: z.boolean(), version: z.number().int().positive(),
  server_id: IdSchema.nullable(), source: z.string().nullable(), retired: z.boolean(), retire_reason: z.enum(['source_missing', 'unhealthy']).nullable(), tls_insecure: z.boolean(), state: ProxyStateSchema, cooldown_until: NullableTime, last_success_at: NullableTime, last_failure_at: NullableTime, last_error: z.string().max(120).nullable(),
  requests_today: z.number().int().nonnegative(), failures_today: z.number().int().nonnegative(), latency_ms: z.number().int().nonnegative().nullable(), observed_at: NullableTime, created_at: Timestamp, updated_at: Timestamp,
});
const Tally = z.number().int().nonnegative();
export const ProxyOverviewSchema: z.ZodType<ProxyOverview> = z.strictObject({
  observed_at: Timestamp, items: z.array(ProxyViewSchema).max(1000), items_total: z.number().int().nonnegative(),
  by_state: z.record(ProxyStateSchema, Tally) as z.ZodType<Record<ProxyState, number>>,
  providers: z.array(z.strictObject({ name: z.string(), count: Tally, requests_today: Tally, failures_today: Tally })).max(200),
  groups: z.array(z.strictObject({ name: z.string(), count: Tally })).max(200), requests_today: Tally, failures_today: Tally,
  availability_7d: z.array(z.strictObject({ day: z.iso.date(), requests: Tally, failures: Tally })).max(7),
});
export const ProxyUpdateSchema = z.strictObject({ expected_version: z.number().int().positive(), enabled: z.boolean().optional(), server_id: IdSchema.nullable().optional() })
  .refine(u => u.enabled !== undefined || u.server_id !== undefined, 'nothing to update');
/** Upper bound of endpoints assigned to one server; sync requests and responses carry at most this many. */
export const MAX_PROXIES_PER_SERVER = 500;
/** Proxy Manager sync: report observed state, receive this server's assignments (with credentials) and renewed leases. */
export const ProxyObservationSchema = z.strictObject({
  proxy_id: z.uuid(), generation: z.number().int().nonnegative(), state: z.enum(['healthy', 'trial', 'degraded', 'cooldown', 'failed']),
  cooldown_until: NullableTime, last_success_at: NullableTime, last_failure_at: NullableTime, last_error: z.string().max(120).nullable(),
  requests_total: Tally, failures_total: Tally, latency_ms: z.number().int().nonnegative().max(600_000).nullable(),
});
export const ProxySyncRequestSchema = z.strictObject({
  node_boot_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), report_sequence: z.number().int().nonnegative(),
  observed_at: Timestamp, observations: z.array(ProxyObservationSchema).max(MAX_PROXIES_PER_SERVER),
});
export type ProxySyncRequest = z.infer<typeof ProxySyncRequestSchema>;
/** `tls_insecure`: an HTTPS proxy whose own certificate is not verified (only credential-free endpoints; the tunnelled TLS to the target is always verified). */
export interface ProxyAssignment { proxy_id: string; generation: number; protocol: 'http' | 'https' | 'socks5'; host: string; port: number; username: string | null; password: string | null; kind: 'static' | 'rotating'; max_concurrency: number; tls_insecure: boolean; }
export interface ProxySyncResponse { server_id: string; lease_expires_at: string; assignments: ProxyAssignment[]; }
export const ProxySyncResponseSchema: z.ZodType<ProxySyncResponse> = z.strictObject({ server_id: IdSchema, lease_expires_at: Timestamp, assignments: z.array(z.strictObject({
  proxy_id: z.uuid(), generation: z.number().int().nonnegative(), protocol: z.enum(['http', 'https', 'socks5']), host: Host, port: z.number().int(), username: z.string().nullable(),
  password: z.string().nullable(), kind: z.enum(['static', 'rotating']), max_concurrency: z.number().int(), tls_insecure: z.boolean() })).max(MAX_PROXIES_PER_SERVER) });
/** Subscription source: an HTTPS URL listing endpoints (host:port or scheme://[user:pass@]host:port per line), refreshed on a schedule. */
const SourceFields = {
  name: GroupName, url: z.url().max(2048).refine(u => u.startsWith('https://'), 'HTTPS only'),
  protocol: z.enum(['http', 'https', 'socks5']), provider: GroupName, group: GroupName, country_code: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  kind: z.enum(['static', 'rotating']).default('static'), max_concurrency: z.number().int().min(1).max(64).default(2),
  interval_minutes: z.number().int().min(10).max(1440).default(60), retire_after_misses: z.number().int().min(1).max(20).default(3),
  server_ids: z.array(IdSchema).max(20).default([]),
  // Opt-in: HTTPS proxies the list marks skip-cert-verify (Clash) are used without verifying the proxy's own certificate.
  allow_insecure_tls: z.boolean().default(false),
};
export const ProxySourceCreateSchema = z.strictObject(SourceFields);
export type ProxySourceCreate = z.input<typeof ProxySourceCreateSchema>;
export const ProxySourceUpdateSchema = z.strictObject({ expected_version: z.number().int().positive(), enabled: z.boolean().optional(),
  interval_minutes: SourceFields.interval_minutes.unwrap().optional(), server_ids: z.array(IdSchema).max(20).optional(), refresh_now: z.literal(true).optional() });
export interface ProxySourceView {
  source_id: string; name: string; url: string; protocol: 'http' | 'https' | 'socks5'; provider: string; group: string; country_code: string | null; kind: 'static' | 'rotating';
  max_concurrency: number; interval_minutes: number; retire_after_misses: number; server_ids: string[]; allow_insecure_tls: boolean; enabled: boolean; version: number;
  next_fetch_at: string; last_fetched_at: string | null; last_status: 'ok' | 'not_modified' | 'error' | null; last_error: string | null;
  last_count: number | null; last_added: number | null; last_retired: number | null; active_proxies: number; retired_proxies: number;
}
export const ProxySourceViewSchema: z.ZodType<ProxySourceView> = z.strictObject({
  source_id: z.uuid(), name: z.string(), url: z.string(), protocol: z.enum(['http', 'https', 'socks5']), provider: z.string(), group: z.string(), country_code: z.string().nullable(), kind: z.enum(['static', 'rotating']),
  max_concurrency: z.number().int(), interval_minutes: z.number().int(), retire_after_misses: z.number().int(), server_ids: z.array(IdSchema), allow_insecure_tls: z.boolean(), enabled: z.boolean(), version: z.number().int().positive(),
  next_fetch_at: Timestamp, last_fetched_at: NullableTime, last_status: z.enum(['ok', 'not_modified', 'error']).nullable(), last_error: z.string().nullable(),
  last_count: z.number().int().nullable(), last_added: z.number().int().nullable(), last_retired: z.number().int().nullable(), active_proxies: Tally, retired_proxies: Tally,
});
