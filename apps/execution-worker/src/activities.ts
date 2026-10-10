import { randomUUID } from 'node:crypto';
import { Context, heartbeat, CancelledFailure, ApplicationFailure } from '@temporalio/activity';
import { contentHash, fixtureSubmission, stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { ExecutionApi, ExecutionApiError, checkReceipt } from '@crawlsystem/execution-client/http';
import type { RequestTracing } from '@crawlsystem/http/tracing';
import { CONTRACT_VERSION, type AgentResult, type Domain, type ErrorCode, type ExecutionEvent, type PlanWorkflowResult, type PlanInput, type PlanStatus, type Submission, type VideoItem, type WorkflowInput, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataApi, DataApiError, type RequestGuard } from './youtube/data-api.ts';
import { aboutPage, ScrapeError, session, shortsIds, topComments } from './youtube/scrape.ts';
import { toChannelFacts, toVideoFacts, unavailableVideo } from './youtube/map.ts';
import { LeaseClient, ProxyUnavailable, proxiedFetch, type Outcome } from './youtube/transport.ts';
import type { ProfileClient } from './profile-client.ts';
import type { WebCollector, CollectionContext } from './youtube/web-collector.ts';
import { ArchiveError } from './raw-archive.ts';
import { FingerprintError } from './youtube/fingerprint.ts';

export interface ExecutionDescriptor { deadlineAt: number; maxAttempts: number; status: PlanStatus; sourceMode?: 'fixture' | 'youtube'; videoBatches?: number | null; requiresAgent?: boolean; }
export const VIDEO_BATCH = 10;
export interface ActivityOptions {
  api: ExecutionApi; workerId: string; workspaceId: string;
  enter: (planId: string) => () => void;
  log: (record: Record<string, unknown>) => void;
  tracing?: RequestTracing;
  /** Real collection: Data API (direct, keyed) and this node's Proxy Manager (or 'direct' for local development only). */
  youtube?: { dataApi: DataApi; proxies: LeaseClient | 'direct'; web?: WebCollector };
  /** Profile Agent (local models) producing the AGENT domain from the Store's input snapshot. */
  profiler?: ProfileClient;
}
/** Collector failures as execution errors: transient upstream/proxy trouble retries; missing targets and quota do not. */
function collectorError(error: unknown): ExecutionApiError {
  if (error instanceof ExecutionApiError) return error;
  if (error instanceof ArchiveError || error instanceof FingerprintError) return new ExecutionApiError('UNAVAILABLE', true);
  if (error instanceof DataApiError) return new ExecutionApiError(error.kind === 'quota' ? 'BUDGET_EXHAUSTED' : error.kind === 'not_found' ? 'NOT_FOUND' : error.kind === 'forbidden' ? 'FORBIDDEN' : error.kind === 'invalid' ? 'INVALID_REQUEST' : 'UNAVAILABLE', error.retryable);
  if (error instanceof ScrapeError) return new ExecutionApiError(error.kind === 'not_found' ? 'NOT_FOUND' : 'UNAVAILABLE', error.kind !== 'not_found');
  return new ExecutionApiError('INTERNAL_ERROR', false);
}
/** Per-Activity trace: opened once the plan's stored context is read, then sent on every call. */
interface TraceScope { traceparent?: string; end?: (failed: boolean) => void; }
const terminal = (status: PlanStatus) => ['COMPLETED','CANCELLED','FAILED'].includes(status);

/** Validate the durable input on every attempt, including those after process replacement. */
export function verifyContext(ref: WorkflowInput, value: PlanInput, workspaceId: string): void {
  const { plan, input } = value;
  if (ref.workspace_id !== workspaceId || plan.workspace_id !== ref.workspace_id || plan.plan_id !== ref.plan_id ||
      plan.workflow_id !== ref.workflow_id || ref.workflow_id !== `m1/${ref.workspace_id}/${ref.plan_id}` ||
      plan.input_hash !== ref.input_hash || contentHash(input) !== ref.input_hash || plan.deadline_at !== input.deadline_at ||
      plan.channel_id !== input.channel_id || contentHash(plan.required_domains) !== contentHash(input.required_domains)) throw new ExecutionApiError('INPUT_MISMATCH', false);
  // A cancelled/failed plan increments its epoch. It must remain readable for reconciliation.
  if (!terminal(plan.status) && plan.execution_epoch !== ref.execution_epoch) throw new ExecutionApiError('STALE_EXECUTION', false);
}

export function createActivities(options: ActivityOptions) {
  const { api, workerId } = options;
  const read = async (ref: WorkflowInput, scope: TraceScope, deadline?: number) => {
    const value = await api.input(ref.plan_id, { signal: Context.current().cancellationSignal, deadline, traceparent: scope.traceparent });
    verifyContext(ref, value, options.workspaceId);
    if (!scope.end && options.tracing) {
      const info = Context.current().info;
      const span = options.tracing.child(value.trace_context, `activity ${info.activityType}`, { 'business.plan_id': ref.plan_id, 'temporal.attempt': info.attempt, 'worker.id': workerId });
      scope.traceparent = span.traceparent; scope.end = span.end;
    }
    return value;
  };
  const event = (ref: WorkflowInput, scope: TraceScope, kind: ExecutionEvent['kind'], phase: string, message: string, domain: Domain | null = null, errorCode?: ErrorCode) =>
    api.event(ref.plan_id, { event_id: randomUUID(), execution_epoch: ref.execution_epoch, worker_id: workerId, kind, phase, domain,
      message, ...(errorCode ? { error_code: errorCode } : {}) }, { signal: Context.current().cancellationSignal, traceparent: scope.traceparent });

  async function activity<T>(ref: WorkflowInput, phase: string, work: (scope: TraceScope) => Promise<T>): Promise<T> {
    const leave = options.enter(ref.plan_id);
    const context = Context.current(), scope: TraceScope = {};
    let failed = false;
    const beat = () => heartbeat({ plan_id: ref.plan_id, phase });
    beat(); const timer = setInterval(beat, 1000);
    try { return await work(scope); }
    catch (cause) {
      failed = true;
      if (context.cancellationSignal.aborted) throw new CancelledFailure('Execution interrupted; recover using original input and receipts');
      const error = cause instanceof ExecutionApiError ? cause : new ExecutionApiError('INTERNAL_ERROR', false);
      const record = { worker_id: workerId, plan_id: ref.plan_id, workflow_id: ref.workflow_id, execution_epoch: ref.execution_epoch,
        phase, error_code: error.code, retryable: error.retryable, correlation_id: error.correlationId, attempt: context.info.attempt };
      options.log(record);
      await event(ref, scope, 'ERROR', phase, `${error.code}; retryable=${error.retryable}; attempt=${context.info.attempt}${error.correlationId ? `; correlation=${error.correlationId.slice(0,160)}` : ''}`, null, error.code).catch(() => {});
      throw ApplicationFailure.create({ message: `Execution ${phase}: ${error.code}`, type: error.code, nonRetryable: !error.retryable,
        details: [{ code: error.code, phase, retryable: error.retryable, plan_id: ref.plan_id }] });
    } finally { clearInterval(timer); scope.end?.(failed); leave(); }
  }

  const submissionOf = (ref: WorkflowInput, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission => {
    const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(ref.plan_id, ref.execution_epoch, domain, key), plan_id: ref.plan_id,
      execution_epoch: ref.execution_epoch, input_hash: ref.input_hash, logical_batch_key: key, domain_complete, domain, payload };
    return { ...body, payload_hash: submissionHash(body as never) } as Submission;
  };
  const youtube = () => { if (!options.youtube) throw new ExecutionApiError('DEPENDENCY_NOT_IMPLEMENTED', false); return options.youtube; };
  /** An incremental update ends its Video domain with the recent-video re-read when it has videos to re-read. */
  const resamples = (input: YoutubeFrozenInput) => input.plan_kind === 'UPDATE' && (input.recent_sampling?.video_ids.length ?? 0) > 0;
  const youtubeInput = (value: PlanInput): YoutubeFrozenInput => { if (value.input.source_mode !== 'youtube') throw new ExecutionApiError('INPUT_MISMATCH', false); return value.input; };
  /** Run scraping work through a leased proxy, waiting (visibly, within the deadline) while this node has none free. */
  async function withProxy<T>(ref: WorkflowInput, scope: TraceScope, deadline: number, work: (fetcher: typeof fetch) => Promise<T>): Promise<T> {
    const proxies = youtube().proxies;
    if (proxies === 'direct') return work(fetch);
    let announced = false;
    for (;;) {
      Context.current().cancellationSignal.throwIfAborted();
      let lease;
      try { lease = await proxies.acquire(); }
      catch (error) {
        if (!(error instanceof ProxyUnavailable)) throw error;
        if (Date.now() + error.waitMs >= deadline) throw new ExecutionApiError('BUDGET_EXHAUSTED', false);
        if (!announced) { announced = true; await event(ref, scope, 'WAITING', 'PROXY', `Waiting for a proxy on this node (${error.reason})`).catch(() => {}); }
        await sleep(Math.min(error.waitMs, 30_000), undefined, { signal: Context.current().cancellationSignal });
        continue;
      }
      const transport = proxiedFetch(lease.proxy_url), started = Date.now();
      let outcome: Outcome = 'success', errorClass: string | undefined;
      try { return await work(transport.fetch); }
      catch (error) {
        if (error instanceof ScrapeError && (error.kind === 'blocked' || error.kind === 'network')) { outcome = error.kind === 'blocked' ? 'blocked' : 'failure'; errorClass = `scrape_${error.kind}`; }
        throw error;
      } finally { await transport.close().catch(() => {}); await proxies.release(lease, outcome, Date.now() - started, errorClass); }
    }
  }
  async function collect<T>(ref: WorkflowInput, phase: string, work: (scope: TraceScope) => Promise<T>): Promise<T> {
    return activity(ref, phase, async scope => { try { return await work(scope); } catch (error) { throw collectorError(error); } });
  }
  const submitOnce = async (ref: WorkflowInput, value: PlanInput, submission: Submission, deadline: number) =>
    value.receipts.some(r => r.submission_id === submission.submission_id) ? undefined : api.submit(submission, { deadline, signal: Context.current().cancellationSignal });
  /** Data API guard: one quota permit per request (stops the plan when the day's budget is spent); failures are recorded by reason. */
  const permit = (ref: WorkflowInput, scope: TraceScope, deadline: number): RequestGuard => {
    const budget = () => ({ deadline, signal: Context.current().cancellationSignal, traceparent: scope.traceparent });
    const owner = { plan_id: ref.plan_id, execution_epoch: ref.execution_epoch, input_hash: ref.input_hash };
    return {
      async permit(endpoint) {
        const request_id = randomUUID(), result = await api.dataApiPermit({ request_id, ...owner, endpoint }, budget());
        if (!result.granted) {
          await event(ref, scope, 'WAITING', 'API_QUOTA', `Data API daily budget exhausted; resets ${result.reset_at}`, null, 'BUDGET_EXHAUSTED');
          throw new ExecutionApiError('BUDGET_EXHAUSTED', false);
        }
        return request_id;
      },
      async failed(request_id, _endpoint, error) {
        if (request_id) await api.dataApiFailure({ request_id, ...owner, reason: error.kind }, budget()).catch(() => undefined);
      },
    };
  };

  const collection = (ref: WorkflowInput, input: YoutubeFrozenInput, scope: TraceScope, deadline: number): CollectionContext => ({
    owner: ref, channelId: input.channel_id, signal: AbortSignal.any([Context.current().cancellationSignal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]), deadline,
    guard: permit(ref, scope, deadline), note: message => event(ref, scope, 'PROGRESS', 'COLLECTOR', message, 'VIDEO').then(() => undefined).catch(() => undefined),
  });


  return {
    /** YouTube ABOUT: About page through a proxy plus exact counts from the Data API. */
    async collectAbout(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<PlanWorkflowResult> {
      return collect(ref, 'ABOUT', async scope => {
        const value = await read(ref, scope, descriptor.deadlineAt), input = youtubeInput(value);
        const done = () => ({ plan_id: ref.plan_id, status: value.plan.status });
        if (terminal(value.plan.status) || !input.required_domains.includes('ABOUT') || value.domains.find(d => d.domain === 'ABOUT')?.state === 'APPLIED') return done();
        await event(ref, scope, 'STARTED', 'ABOUT', `Collecting channel ${input.channel_id}`, 'ABOUT');
        let facts;
        if (youtube().web) facts = await youtube().web!.about(collection(ref, input, scope, descriptor.deadlineAt));
        else {
          const channel = await youtube().dataApi.channel(input.channel_id, permit(ref, scope, descriptor.deadlineAt));
          if (!channel) throw new ExecutionApiError('NOT_FOUND', false);
          const about = await withProxy(ref, scope, descriptor.deadlineAt, async fetcher => aboutPage(await session(fetcher), input.channel_id));
          facts = toChannelFacts(channel, about, new Date().toISOString());
        }
        const receipt = await submitOnce(ref, value, submissionOf(ref, 'ABOUT', 'about:channel', facts, true), descriptor.deadlineAt);
        await event(ref, scope, 'PROGRESS', 'ABOUT', `APPLIED receipt=${receipt?.submission_id ?? 'existing'}`, 'ABOUT');
        return { plan_id: ref.plan_id, status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
      });
    },
    /** Freeze VIDEO targets once: newest uploads inside the frozen window and limit (Data API, exact publish times). */
    async listTargets(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<{ batches: number; status: PlanStatus }> {
      return collect(ref, 'TARGETS', async scope => {
        let value = await read(ref, scope, descriptor.deadlineAt);
        const input = youtubeInput(value);
        if (!input.required_domains.includes('VIDEO') || terminal(value.plan.status)) return { batches: 0, status: value.plan.status };
        if (!value.video_targets && input.plan_kind === 'UPDATE') {
          // Incremental update: only uploads above the newest known videos (legacy discovery anchors).
          const found = youtube().web ? await youtube().web!.targets(collection(ref, input, scope, descriptor.deadlineAt), 100, input.discovery_anchor_ids ?? [])
            : await youtube().dataApi.uploadsUntilAnchor(`UU${input.channel_id.slice(2)}`, input.discovery_anchor_ids ?? [], permit(ref, scope, descriptor.deadlineAt));
          const manifest = { kind: 'discovery', channel_id: input.channel_id, video_ids: found.ids, listed_at: new Date().toISOString(), scanned_count: found.scanned,
            pages: found.pages, matched_anchor_id: found.matched_anchor_id, stop_reason: found.stop_reason, source: youtube().web ? 'youtubei:uploads' : 'data_api:playlistItems' };
          await submitOnce(ref, value, submissionOf(ref, 'VIDEO', 'video:discovery', manifest, found.ids.length === 0 && !resamples(input)), descriptor.deadlineAt);
          const how = { anchor_matched: 'reached the newest known video', list_end: 'reached the end of the uploads', gap_abandoned_latest_30: 'too many new uploads; kept the newest 30' }[found.stop_reason];
          await event(ref, scope, 'PROGRESS', 'DISCOVERY', `Found ${found.ids.length} new videos (${how})`, 'VIDEO');
          value = await read(ref, scope, descriptor.deadlineAt);
        }
        if (!value.video_targets) {
          const windowStart = new Date(youtube().web ? 0 : Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString();
          const listed = youtube().web ? await youtube().web!.targets(collection(ref, input, scope, descriptor.deadlineAt), input.scope.video_limit)
            : await youtube().dataApi.recentUploads(`UU${input.channel_id.slice(2)}`, windowStart, input.scope.video_limit, permit(ref, scope, descriptor.deadlineAt));
          const manifest = { kind: 'targets', channel_id: input.channel_id, video_ids: listed.ids, listed_at: new Date().toISOString(), window_start: windowStart, exhausted: listed.exhausted, source: youtube().web ? 'youtubei:uploads' : 'data_api:playlistItems' };
          await submitOnce(ref, value, submissionOf(ref, 'VIDEO', 'video:targets', manifest, listed.ids.length === 0), descriptor.deadlineAt);
          await event(ref, scope, 'PROGRESS', 'TARGETS', `Frozen ${listed.ids.length} video targets since ${windowStart.slice(0, 10)}${listed.exhausted ? '' : ' (limit reached)'}`, 'VIDEO');
          value = await read(ref, scope, descriptor.deadlineAt);
        }
        return { batches: Math.ceil((value.video_targets ?? []).length / VIDEO_BATCH), status: value.plan.status };
      });
    },
    /** One batch of up to ten frozen targets: Data API facts, Shorts tab and Top comments through a proxy. */
    async collectVideoBatch(ref: WorkflowInput, descriptor: ExecutionDescriptor, index: number): Promise<{ status: PlanStatus }> {
      return collect(ref, 'VIDEO', async scope => {
        const value = await read(ref, scope, descriptor.deadlineAt), input = youtubeInput(value);
        const targets = value.video_targets ?? [], batch = targets.slice(index * VIDEO_BATCH, (index + 1) * VIDEO_BATCH);
        const key = `video:batch:${index}`, last = (index + 1) * VIDEO_BATCH >= targets.length;
        if (terminal(value.plan.status) || !batch.length || value.receipts.some(r => r.logical_batch_key === key)) return { status: value.plan.status };
        const observed = new Date().toISOString();
        const facts = youtube().web ? [] : await youtube().dataApi.videos(batch, permit(ref, scope, descriptor.deadlineAt));
        const byId = new Map(facts.map(v => [v.id, v]));
        const items: VideoItem[] = youtube().web ? await youtube().web!.videos(collection(ref, input, scope, descriptor.deadlineAt), batch, input.scope.comments_per_video, `VIDEO-${index}`) : await withProxy(ref, scope, descriptor.deadlineAt, async fetcher => {
          const yt = await session(fetcher);
          const shorts = await shortsIds(yt, input.channel_id).catch(() => null);
          const out: VideoItem[] = [];
          for (const id of batch) {
            const api = byId.get(id);
            if (!api || api.snippet.channelId !== input.channel_id) { out.push(unavailableVideo(input.channel_id, id, observed)); continue; }
            const comments = input.scope.comments_per_video === 0 ? { kind: 'skipped' as const } : await topComments(yt, id, api.statistics?.commentCount);
            out.push(toVideoFacts(api, shorts ? shorts.has(id) : null, comments, input.scope.comments_per_video, observed));
            heartbeat({ plan_id: ref.plan_id, phase: 'VIDEO', done: out.length, of: batch.length });
          }
          return out;
        });
        const receipt = await submitOnce(ref, value, submissionOf(ref, 'VIDEO', key, { kind: 'videos', items }, last && !resamples(input)), descriptor.deadlineAt);
        const missing = items.filter(i => 'unavailable' in i).length;
        await event(ref, scope, 'PROGRESS', 'VIDEO', `Batch ${index + 1}/${Math.ceil(targets.length / VIDEO_BATCH)}: ${items.length - missing} videos${missing ? `, ${missing} unavailable` : ''}; receipt=${receipt?.submission_id ?? 'existing'}`, 'VIDEO');
        return { status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
      });
    },
    /** Incremental update: re-read the frozen recent videos' counts from the Data API (no proxy; comments are not re-read). */
    async sampleRecentVideos(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<{ status: PlanStatus }> {
      return collect(ref, 'SAMPLING', async scope => {
        const value = await read(ref, scope, descriptor.deadlineAt), input = youtubeInput(value), key = 'video:samples';
        const ids = input.recent_sampling?.video_ids ?? [];
        if (terminal(value.plan.status) || !input.required_domains.includes('VIDEO') || !ids.length || value.receipts.some(r => r.logical_batch_key === key)) return { status: value.plan.status };
        const observed = new Date().toISOString();
        const byId = new Map((youtube().web ? [] : await youtube().dataApi.videos(ids, permit(ref, scope, descriptor.deadlineAt))).map(v => [v.id, v]));
        const webItems = youtube().web ? await youtube().web!.videos(collection(ref, input, scope, descriptor.deadlineAt), ids, 0, 'SAMPLING', true) : null;
        const count = (text?: string) => text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
        const items = webItems ? webItems.filter((v): v is import('@crawlsystem/contracts').VideoFacts => !('unavailable' in v)).map(v => ({ video_id: v.source_content_id, view_count: v.view_count.value, like_count: v.like_count.value, comment_count: v.comment_count.value })) : ids.filter(id => byId.get(id)?.snippet.channelId === input.channel_id).map(id => {
          const stats = byId.get(id)!.statistics ?? {};
          return { video_id: id, view_count: count(stats.viewCount), like_count: count(stats.likeCount), comment_count: count(stats.commentCount) };
        });
        const missing = ids.filter(id => !items.some(item => item.video_id === id));
        const receipt = await submitOnce(ref, value, submissionOf(ref, 'VIDEO', key, { kind: 'samples', observed_at: observed, source: youtube().web ? 'youtubei:video_or_api_fallback' : 'data_api:videos', items, missing_video_ids: missing }, true), descriptor.deadlineAt);
        await event(ref, scope, 'PROGRESS', 'SAMPLING', `Re-read ${items.length} recent videos${missing.length ? `, ${missing.length} no longer available` : ''}; receipt=${receipt?.submission_id ?? 'existing'}`, 'VIDEO');
        return { status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
      });
    },
    /** AGENT: profile the Store's snapshot of this plan's facts with the local models and submit it bound to that snapshot's hash. */
    async collectAgent(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<{ status: PlanStatus }> {
      return activity(ref, 'AGENT', async scope => {
        const value = await read(ref, scope, descriptor.deadlineAt);
        if (terminal(value.plan.status) || !value.input.required_domains.includes('AGENT') || value.domains.find(d => d.domain === 'AGENT')?.state === 'APPLIED') return { status: value.plan.status };
        if (!options.profiler) throw new ExecutionApiError('DEPENDENCY_NOT_IMPLEMENTED', false);
        const budget = { deadline: descriptor.deadlineAt, signal: Context.current().cancellationSignal, traceparent: scope.traceparent };
        await event(ref, scope, 'STARTED', 'AGENT', 'Profiling the collected channel facts with the local models', 'AGENT');
        // The facts can be rewritten by another plan of the same channel between reading and
        // submitting; the Store then rejects the stale hash and the profile is computed again.
        for (let attempt = 1; ; attempt++) {
          const input = await api.agentInput(ref.plan_id, budget);
          const profile = await options.profiler.profile(input, budget);
          const payload: AgentResult = { channel_id: input.channel_id, input_hash: input.input_hash, model_version: profile.model_version,
            taxonomy_version: profile.taxonomy_version, observed_at: profile.observed_at, facts: profile.facts };
          try {
            const receipt = await submitOnce(ref, value, submissionOf(ref, 'AGENT', `agent:profile:${input.input_hash.slice(7, 23)}`, payload, true), descriptor.deadlineAt);
            await event(ref, scope, 'PROGRESS', 'AGENT', `APPLIED ${input.videos.length} videos profiled by ${profile.model_version.slice(0, 200)}; receipt=${receipt?.submission_id ?? 'existing'}`, 'AGENT');
            break;
          } catch (error) {
            if (!(error instanceof ExecutionApiError) || error.code !== 'INPUT_MISMATCH' || attempt >= 3) throw error;
          }
        }
        return { status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
      });
    },
    /** Replaced by collectAgent; kept only so workflows started before M2 step 5 can finish their recorded path. */
    async awaitAgent(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<PlanWorkflowResult> {
      return activity(ref, 'AGENT', async scope => {
        const value = await read(ref, scope, descriptor.deadlineAt);
        if (!terminal(value.plan.status)) await event(ref, scope, 'WAITING', 'AGENT', 'Agent profiling is not deployed yet', 'AGENT', 'DEPENDENCY_NOT_IMPLEMENTED');
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
    async loadExecution(ref: WorkflowInput): Promise<ExecutionDescriptor> {
      return activity(ref, 'INPUT', async scope => {
        const value = await read(ref, scope);
        return { deadlineAt: Date.parse(value.input.deadline_at), maxAttempts: value.input.max_attempts, status: value.plan.status, sourceMode: value.input.source_mode,
          requiresAgent: value.input.required_domains.includes('AGENT') };
      });
    },
    async executeFixture(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<PlanWorkflowResult> {
      return activity(ref, 'SUBMISSION', async scope => {
        let value = await read(ref, scope, descriptor.deadlineAt);
        if (Date.parse(value.input.deadline_at) !== descriptor.deadlineAt || value.input.max_attempts !== descriptor.maxAttempts) throw new ExecutionApiError('INPUT_MISMATCH', false);
        if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        if (value.input.source_mode !== 'fixture') {
          // Real collection lands in M2 step 4; until then the plan waits visibly instead of failing silently.
          await event(ref, scope, 'WAITING', 'COLLECTOR', 'YouTube collector is not deployed yet', null, 'DEPENDENCY_NOT_IMPLEMENTED');
          return { plan_id: ref.plan_id, status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
        }
        await event(ref, scope, 'STARTED', 'FIXTURE', 'Reading frozen test sample; no real collection or proxy');
        for (const domain of ['ABOUT','VIDEO'] as const) {
          if (!value.input.required_domains.includes(domain)) continue;
          // Use the original epoch, including while inspecting receipts of a cancelled run.
          const submission = fixtureSubmission({ ...value, plan: { ...value.plan, execution_epoch: ref.execution_epoch } }, domain);
          const checkpoint = value.receipts.find(receipt => receipt.submission_id === submission.submission_id);
          const receipt = checkpoint ? checkReceipt(submission, checkpoint) : await api.submit(submission, {
            deadline: descriptor.deadlineAt, signal: Context.current().cancellationSignal, traceparent: scope.traceparent,
          });
          heartbeat({ plan_id: ref.plan_id, phase: domain, submission_id: receipt.submission_id });
          await event(ref, scope, 'PROGRESS', domain, `APPLIED receipt=${receipt.submission_id}`, domain);
          value = await read(ref, scope, descriptor.deadlineAt);
          if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        }
        // Store is authoritative, including missing domains and concurrent cancellation.
        value = await read(ref, scope, descriptor.deadlineAt);
        if (!terminal(value.plan.status)) {
          await event(ref, scope, 'WAITING', 'DEPENDENCY', 'Required domain is pending; real Agent/API is not implemented in M1', null, 'DEPENDENCY_NOT_IMPLEMENTED');
          value = await read(ref, scope, descriptor.deadlineAt);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
    async settleExecution(ref: WorkflowInput, failure?: ErrorCode): Promise<PlanWorkflowResult> {
      return activity(ref, 'SETTLE', async scope => {
        let value = await read(ref, scope);
        if (!terminal(value.plan.status) && failure) {
          await event(ref, scope, 'FAILED', 'SETTLE', `Execution stopped: ${failure}`, null, failure);
          value = await read(ref, scope);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
