// Explicit browser-test fixtures. Never imported by the application.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, PlanSchema, PlanDetailSchema, ReceiptSchema, WorkerSchema, StoredEventSchema, ChannelDetailSchema, type Plan, type Domain } from '@crawlsystem/contracts';
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
    clock('AGENT', 180, 188, ['agent_semantic_baseline', 'agent_forward_load_spread'])] } : { state: null, version: 0, changed_at: null, clocks: [] };
  return ChannelDetailSchema.parse({ channel_id: fixtureChannel.channel_id, title: fixtureChannel.title, source_mode: managed ? 'youtube' : 'fixture', updated_at: timestamp, latest_plan_id: plan.plan_id, about: fixtureChannel, videos: [fixtureVideo], agent: null, latest_plan: plan, management });
}
