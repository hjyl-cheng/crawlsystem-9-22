// Explicit browser-test fixtures. Never imported by the application.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, PlanSchema, PlanDetailSchema, ReceiptSchema, WorkerSchema, StoredEventSchema, ChannelDetailSchema, UpdateChannelSchema, UpdateSummarySchema, AgentTaskSchema, AgentSummarySchema, DataApiSummarySchema, QueryBindingSchema, QuerySummarySchema, type QueryBinding, type Plan, type Domain, type UpdateChannel, type AgentTask } from '@crawlsystem/contracts';
import { createFrozenFixture, fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { contentHash, fixtureSubmission } from '@crawlsystem/contracts/hash';

export const timestamp = '2026-09-23T08:00:00.000Z';
export function detailFixture(overrides: Partial<Plan> = {}, applied: Domain[] = []) {
  const required = overrides.required_domains ?? ['ABOUT', 'VIDEO'];
  const input = createFrozenFixture(required, '2026-09-23T08:30:00.000Z');
  const plan = PlanSchema.parse({ plan_id: randomUUID(), run_id: randomUUID(), workspace_id: 'console-browser-fixture', channel_id: fixtureChannel.channel_id, source_revision: 1, source_mode: 'fixture', fixture_id: 'channel-basic-v1', required_domains: required, status: 'QUEUED', version: 1, execution_epoch: 1, input_hash: contentHash(input), workflow_id: 'fixture-workflow', created_at: timestamp, updated_at: timestamp, finished_at: null, deadline_at: input.deadline_at, publication_status: 'NOT_ENABLED', ...overrides });
  const context = { plan, input, domains: required.map(domain => ({ domain, state: applied.includes(domain) ? 'APPLIED' as const : 'PENDING' as const, completed_at: applied.includes(domain) ? timestamp : null })), receipts: [] };
  const receipts = applied.filter((d): d is 'ABOUT'|'VIDEO' => d !== 'AGENT').map(domain => {
    const submission = fixtureSubmission(context, domain);
    return ReceiptSchema.parse({ schema_version: CONTRACT_VERSION, submission_id: submission.submission_id, plan_id: plan.plan_id, logical_batch_key: submission.logical_batch_key, domain, payload_hash: submission.payload_hash, state: 'APPLIED', applied_at: timestamp });
  });
  return PlanDetailSchema.parse({ ...context, receipts, events: [] });
}
export function workerFixture(stale = false) {
  return WorkerSchema.parse({ worker_id: 'fixture-worker', server_id: 'fixture-node', build_version: 'm1.v1-test', accepting_work: true, capacity: 2, running_plan_ids: [], last_heartbeat_at: timestamp, stale, proxy_status: 'NOT_CONFIGURED' });
}
export function errorFixture(planId: string) {
  return StoredEventSchema.parse({ event_id: randomUUID(), plan_id: planId, execution_epoch: 1, worker_id: 'fixture-worker', phase: 'fixture-ingest', kind: 'ERROR', domain: 'VIDEO', message: '测试专用：视频结果提交失败', error_code: 'UNAVAILABLE', created_at: timestamp });
}
/** The fixture channel; `managed` presents it as a real managed channel with three clocks due in 1, 3 and 188 days. */
export function channelFixture(plan: Plan, managed = false) {
  const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const clock = (name: 'ABOUT' | 'VIDEO' | 'AGENT', interval_days: number, days: number, reasons: string[]) => ({ clock: name, due_at: due(days), next_due_at: due(days), interval_days,
    policy_version: 'v16-rule-7', retry_at: null, reasons, last_success_at: timestamp, last_attempt_at: timestamp, last_plan_id: plan.plan_id, override_days: null });
  const management = managed ? { state: 'managed', version: 3, changed_at: timestamp, clocks: [
    clock('ABOUT', 1, 1, ['about_baseline', 'about_cold_start_cadence_1d']), clock('VIDEO', 3, 3, ['active_irregular_channel', 'automatic_video_min_interval']),
    clock('AGENT', 180, 188, ['agent_semantic_baseline', 'agent_forward_load_spread'])], auto_domains: ['ABOUT', 'VIDEO'] } : { state: null, version: 0, changed_at: null, clocks: [], auto_domains: ['ABOUT', 'VIDEO'] };
  return ChannelDetailSchema.parse({ channel_id: fixtureChannel.channel_id, title: fixtureChannel.title, source_mode: managed ? 'youtube' : 'fixture', updated_at: timestamp, latest_plan_id: plan.plan_id, about: fixtureChannel, videos: [fixtureVideo], agent: null, latest_plan: plan, management });
}
/** A managed channel whose About is due and waits for Data API quota. */
export function updateChannelFixture(): UpdateChannel {
  return UpdateChannelSchema.parse({ channel_id: 'UCupdatefixture000000001', title: '更新测试频道', country: 'US', management_version: 3, state: 'due', due_domains: ['ABOUT'],
    due_at: '2026-09-22T00:00:00.000Z', last_success_at: timestamp, waiting_reason: 'api_quota', active_plan_id: null, plan: null, event: null });
}
/** Scheduler figures for the given rows (only due rows exist in these fixtures). */
export function updateSummaryFixture(rows: UpdateChannel[]) {
  return UpdateSummarySchema.parse({ observed_at: timestamp, limits: { enabled: true, max_active_plans: 2, max_agent_plans: 1, daily_plan_limit: 100, api_daily_limit: 10000 },
    last_scan_at: timestamp, managed: rows.length, due: rows.length, overdue: rows.length, queued: 0, running: 0, completed_24h: 0, failed_24h: 0, daily_plans: 0,
    api_quota_day: '2026-09-23', api_used_units: 9998, api_reserved_units: 0, api_reset_at: '2026-09-24T07:00:00.000Z',
    waiting: rows.length ? [{ reason: 'api_quota', channels: rows.length }] : [] });
}
/** One Agent task per state; the completed one belongs to a managed channel. */
export function agentTaskFixtures(): AgentTask[] {
  const task = (state: AgentTask['state'], extra: Partial<AgentTask> = {}) => AgentTaskSchema.parse({ plan_id: randomUUID(), channel_id: fixtureChannel.channel_id, title: `画像测试频道 ${state}`, country: 'US',
    trigger: 'scheduled', state, waiting_on: [], created_at: timestamp, completed_at: null, finished_at: null, message: null, error_code: null, management_state: 'managed', management_version: 2, next_due_at: null, ...extra });
  return [task('running'), task('waiting', { waiting_on: ['ABOUT', 'VIDEO'], trigger: 'first' }), task('completed', { completed_at: timestamp, next_due_at: '2027-04-14T00:00:00.000Z' }),
    task('failed', { trigger: 'manual', message: 'Profile Agent unavailable', error_code: 'UNAVAILABLE', finished_at: timestamp })];
}
export function agentSummaryFixture(tasks: AgentTask[]) {
  const count = (state: AgentTask['state']) => tasks.filter(t => t.state === state).length;
  return AgentSummarySchema.parse({ observed_at: timestamp, waiting: count('waiting'), running: count('running'), completed_24h: count('completed'), failed_24h: count('failed'),
    avg_seconds_24h: tasks.length ? 600 : null, profiled_channels: count('completed'), model_versions: tasks.length ? [{ model_version: 'qy-channel-profile:test', channels: 1 }] : [] });
}
/** Data API figures: nothing yet, or 84 calls this hour with one quota failure. */
export function dataApiSummaryFixture(calls: boolean) {
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: new Date(Date.parse(timestamp) - (23 - i) * 3_600_000).toISOString(), calls: calls && i === 23 ? 84 : 0, failures: calls && i === 23 ? 1 : 0 }));
  return DataApiSummarySchema.parse({ observed_at: timestamp, quota_day: '2026-09-23', reset_at: '2026-09-24T07:00:00.000Z', limit: 10000, used_units: calls ? 120 : 0, reserved_units: calls ? 35 : 0, hourly,
    endpoints: calls ? [{ endpoint: 'videos', calls: 80, failures: 1 }, { endpoint: 'channels', calls: 4, failures: 0 }] : [],
    failures_by_reason: calls ? [{ reason: 'quota', count: 1 }] : [],
    recent_failures: calls ? [{ at: timestamp, endpoint: 'videos', reason: 'quota', plan_id: randomUUID(), channel_id: fixtureChannel.channel_id }] : [] });
}
export function queryBindingFixture(): QueryBinding {
  return QueryBindingSchema.parse({ binding_id: randomUUID(), text: 'rock com atitude', country: 'BR', language: 'pt', category: 'Music', state: 'BOOTSTRAP', cadence: null, cadence_override: null,
    next_run_at: timestamp, last_success_at: null, empty_runs: 0, priority: 56, sources: [{ type: 'AUTO_TAG', ref: 'legacy:crawlsystem:query_terms:1' }], source_count: 1, version: 1, created_at: timestamp });
}
export function querySummaryFixture(bindings: QueryBinding[]) {
  return QuerySummarySchema.parse({ observed_at: timestamp, total: bindings.length, due: bindings.length,
    by_state: { BOOTSTRAP: bindings.length, ACTIVE: 0, COOLDOWN: 0, DORMANT: 0, DISABLED: 0 },
    by_category: bindings.length ? [{ category: 'Music', bindings: bindings.length }] : [], by_country: bindings.length ? [{ country: 'BR', bindings: bindings.length }] : [] });
}
