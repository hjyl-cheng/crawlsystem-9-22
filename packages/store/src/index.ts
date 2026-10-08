import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { CONTRACT_VERSION, WORKER_STALE_SECONDS, TraceparentSchema, FrozenInputSchema, YoutubeVideoIdSchema, isVideoUnavailable, type AgentInput, type VideoItem, SubmissionSchema, CreatePlanSchema, CancelPlanSchema, HeartbeatSchema, ExecutionEventSchema,
  type Principal, type Role, type ErrorCode, type Plan, type PlanInput, type PlanDetail, type Domain, type DomainResult, type FrozenInput, type CreatePlan, type Submission, type Receipt,
  type Page, type Completeness, type PlansSummary, type PlanStatus, type ChannelSummary, type ChannelListItem, type ChannelDetail, type Worker, type Heartbeat, type ExecutionEvent, type StoredEvent, type WorkflowInput, type SourceMode,
  ChannelManagementCommandSchema, ChannelClockOverrideSchema, CLOCK_NAMES, type AgentResult, type ChannelFacts, type ChannelManagement, type ClockName, type VideoFacts, type VideoSamples } from '@crawlsystem/contracts';
import { agentInputHash, contentHash, submissionHash } from '@crawlsystem/contracts/hash';
import { createFrozenFixture } from '@crawlsystem/contracts/fixtures';
import { instantFromDate, type ClockKind, type Observation } from '@crawlsystem/feature-clock';
import { aboutObservation, agentObservation, applyObservations, loadClocks, videoObservation, writeClocks, type ClockActivity, type SamplingResult } from './feature-clocks.ts';
import { ChannelImportSchema, ChannelImportResultSchema, ChannelImportsSchema, parseChannelReference, type ChannelImportResult, type ChannelImports } from '@crawlsystem/contracts';
import { UpdateLimitsSchema, ChannelUpdateSchema, DataApiPermitRequestSchema, DataApiFailureReportSchema, type UpdateLimits, type DataApiPermit, type DataApiSummary, type AgentTask, type AgentSummary } from '@crawlsystem/contracts';
import { readAgentSummary, readAgentTasks, readDataApiSummary } from './operations-view.ts';
import { apiBudget, estimateApiUnits, releaseApiReservation, schedulerState } from './update-budget.ts';
import { readUpdates } from './update-view.ts';
import { nextChangeProbability, planRecentSampling, RECENT_SAMPLING } from './recent-sampling.ts';

export class StoreError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 409, public retryable = false) { super(message); }
}
export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.includes(principal.role)) throw new StoreError('FORBIDDEN', 'This role cannot perform the operation', 403);
}
const iso = (value: Date | string): string => new Date(value).toISOString();
export function toPlan(row: QueryResultRow): Plan {
  return { plan_id: row.plan_id, run_id: row.run_id, workspace_id: row.workspace_id, channel_id: row.channel_id, source_revision: Number(row.source_revision),
    source_mode: row.source_mode, fixture_id: row.fixture_id ?? null, plan_kind: row.plan_kind ?? 'FULL', required_domains: row.required_domains, status: row.status, version: row.version, execution_epoch: row.execution_epoch,
    input_hash: row.input_hash, workflow_id: row.workflow_id, created_at: iso(row.created_at), updated_at: iso(row.updated_at), finished_at: row.finished_at ? iso(row.finished_at) : null,
    deadline_at: iso(row.deadline_at), publication_status: 'NOT_ENABLED' };
}
function page<T>(rows: T[], limit: number, offset: number): Page<T> { return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null }; }
const terminal = (status: string) => ['COMPLETED','CANCELLED','FAILED'].includes(status);
/** A count the source resolved (exact or estimated), else null. */
const resolvedCount = (metric: { value: number | null; status: string }) => ['exact', 'estimated'].includes(metric.status) ? metric.value : null;
export interface Intent { intent_id: string; plan_id: string; kind: 'START' | 'CANCEL'; lease_token: string; attempts: number; input: WorkflowInput; plan_status: string; deadline_at: string; start_never_dispatched: boolean; trace_context?: string; }

export class Store {
  constructor(public readonly pool: Pool, public readonly updateLimits: UpdateLimits = UpdateLimitsSchema.parse({})) {}
  private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL transaction_timeout = '10s'");
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        discard = /connection|timeout/i.test((error as Error).message) || /^08/.test((error as {code?:string}).code ?? '');
        if (!discard) await client.query('ROLLBACK').catch(() => { discard = true; });
        const code = (error as {code?:string}).code;
        if (attempt < 2 && ['40001','40P01'].includes(code ?? '')) continue;
        if (code === '23505') throw new StoreError('CONFLICT', 'Identity already belongs to different content');
        throw error;
      } finally { client.release(discard); }
    }
  }
  private async planRow(client: PoolClient | Pool, principal: Principal, id: string, lock = false): Promise<QueryResultRow> {
    const result = await client.query(`SELECT * FROM m1.plans WHERE plan_id=$1 AND workspace_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, principal.workspace_id]);
    if (!result.rowCount) throw new StoreError('NOT_FOUND', 'Plan not found', 404);
    return result.rows[0]!;
  }
  async createPlan(principal: Principal, raw: CreatePlan, traceContext?: string): Promise<Plan> {
    requireRole(principal, 'operator');
    const input = CreatePlanSchema.parse(raw);
    const trace = TraceparentSchema.safeParse(traceContext).success ? traceContext! : null;
    const requestHash = contentHash(input);
    const planId = randomUUID(), now = new Date();
    // Real collection covers listing, up to 100 videos with comments and Agent inference.
    const deadline = new Date(now.getTime() + ('source_mode' in input ? 120 : 30) * 60_000).toISOString();
    const frozen: FrozenInput = 'source_mode' in input
      ? FrozenInputSchema.parse({ schema_version: CONTRACT_VERSION, source_mode: 'youtube', channel_id: input.channel_id, required_domains: input.required_domains,
          scope: input.scope, reference_time: now.toISOString(), deadline_at: deadline, max_attempts: 3 })
      : createFrozenFixture(input.required_domains, deadline);
    return this.tx(client => this.insertCreatedPlan(client, principal.workspace_id, input, frozen, requestHash, planId, deadline, trace));
  }
  /** The rows of a newly created plan (shared by operator creation and import admission), idempotent by request id. */
  private async insertCreatedPlan(client: PoolClient, workspace: string, input: CreatePlan, frozen: FrozenInput, requestHash: string, planId: string, deadline: string, trace: string | null): Promise<Plan> {
    const fixtureId = frozen.source_mode === 'fixture' ? frozen.fixture_id : null;
    const principal = { workspace_id: workspace };
    {
      if (frozen.source_mode === 'youtube') {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('channel-plan:' || $1 || ':' || $2))", [principal.workspace_id, frozen.channel_id]);
        const replay = (await client.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND request_id=$2', [principal.workspace_id, input.request_id])).rows[0];
        if (replay) {
          if (replay.request_hash !== requestHash) throw new StoreError('CONFLICT', 'Creation identity has different input');
          return toPlan(replay);
        }
        if ((await client.query("SELECT 1 FROM m1.plans WHERE workspace_id=$1 AND channel_id=$2 AND plan_kind='UPDATE' AND status IN ('QUEUED','RUNNING','WAITING')", [principal.workspace_id, frozen.channel_id])).rowCount)
          throw new StoreError('CONFLICT', 'A channel update is already active');
      }
      const inserted = await client.query(`INSERT INTO m1.plans(plan_id,run_id,workspace_id,request_id,request_hash,channel_id,source_mode,fixture_id,required_domains,status,frozen_input,input_hash,workflow_id,deadline_at,trace_context)
        VALUES($1,$2,$3,$4,$5,$6,$14,$7,$8,'QUEUED',$9,$10,$11,$12,$13) ON CONFLICT(workspace_id,request_id) DO NOTHING RETURNING *`,
        [planId, randomUUID(), principal.workspace_id, input.request_id, requestHash, frozen.channel_id, fixtureId, input.required_domains, frozen, contentHash(frozen), `m1/${principal.workspace_id}/${planId}`, deadline, trace, frozen.source_mode]);
      if (!inserted.rowCount) {
        const old = (await client.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND request_id=$2', [principal.workspace_id, input.request_id])).rows[0]!;
        if (old.request_hash !== requestHash) throw new StoreError('CONFLICT', 'Creation identity has different input');
        return toPlan(old);
      }
      const row = inserted.rows[0]!;
      await client.query("INSERT INTO m1.domains(plan_id,domain) SELECT $1,unnest($2::text[])", [planId, input.required_domains]);
      await client.query(`INSERT INTO m1.channels(workspace_id,channel_id,latest_plan_id,latest_plan_revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,channel_id) DO UPDATE SET latest_plan_id=EXCLUDED.latest_plan_id,latest_plan_revision=EXCLUDED.latest_plan_revision,updated_at=clock_timestamp()
        WHERE m1.channels.latest_plan_revision < EXCLUDED.latest_plan_revision`, [principal.workspace_id,frozen.channel_id,planId,row.source_revision]);
      await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'START')", [randomUUID(),planId]);
      return toPlan(row);
    }
  }
  /**
   * Queue channels for a first collection (operator). Each line is a channel ID or /channel/ link; channels
   * already collected, queued, repeated or unreadable are reported, not queued. A failed import can be queued again.
   */
  async importChannels(principal: Principal, raw: unknown): Promise<ChannelImportResult> {
    requireRole(principal, 'operator');
    const command = ChannelImportSchema.parse(raw);
    return this.tx(async client => {
      const items: ChannelImportResult['items'] = [], seen = new Set<string>();
      for (const line of command.lines.map(l => l.trim()).filter(Boolean)) {
        const ref = parseChannelReference(line);
        if (!ref) { items.push({ line, channel_id: null, outcome: 'invalid' }); continue; }
        if ('handle' in ref) { items.push({ line, channel_id: null, outcome: 'handle_unsupported' }); continue; }
        const id = ref.channel_id;
        if (seen.has(id)) { items.push({ line, channel_id: id, outcome: 'duplicate' }); continue; }
        seen.add(id);
        const known = (await client.query('SELECT 1 FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2 AND about IS NOT NULL', [principal.workspace_id, id])).rowCount;
        if (known) { items.push({ line, channel_id: id, outcome: 'known' }); continue; }
        const queued = await client.query(`INSERT INTO m1.channel_imports(workspace_id,channel_id,requested_by,request_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(workspace_id,channel_id) DO UPDATE SET state='queued',plan_id=NULL,requested_by=EXCLUDED.requested_by,request_id=EXCLUDED.request_id,requested_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE m1.channel_imports.state='failed' RETURNING 1`, [principal.workspace_id, id, principal.subject, command.request_id]);
        items.push({ line, channel_id: id, outcome: queued.rowCount ? 'queued' : 'already_queued' });
      }
      return ChannelImportResultSchema.parse({ items, queued: items.filter(i => i.outcome === 'queued').length });
    });
  }
  async channelImports(principal: Principal): Promise<ChannelImports> {
    requireRole(principal, 'reader', 'operator');
    const counts = (await this.pool.query(`SELECT count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='planned')::int AS planned,
      count(*) FILTER(WHERE state='done')::int AS done,count(*) FILTER(WHERE state='failed')::int AS failed FROM m1.channel_imports WHERE workspace_id=$1`, [principal.workspace_id])).rows[0]!;
    const items = (await this.pool.query(`SELECT i.channel_id,i.state,i.requested_at,i.plan_id,c.about->>'title' AS title FROM m1.channel_imports i
      LEFT JOIN m1.channels c USING(workspace_id,channel_id) WHERE i.workspace_id=$1
      ORDER BY CASE i.state WHEN 'planned' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,i.updated_at DESC,i.channel_id LIMIT 100`, [principal.workspace_id])).rows;
    return ChannelImportsSchema.parse({ counts, items: items.map(r => ({ ...r, requested_at: iso(r.requested_at), title: r.title ?? null })) });
  }
  /** First collections for queued imports, while active plans and the Data API quota allow (oldest first). */
  private async admitImports(client: PoolClient, workspace: string, now: Date): Promise<Plan[]> {
    const plans: Plan[] = [], limits = this.updateLimits;
    const queue = (await client.query(`SELECT channel_id FROM m1.channel_imports WHERE workspace_id=$1 AND state='queued' ORDER BY requested_at,channel_id LIMIT 10`, [workspace])).rows;
    for (const { channel_id } of queue) {
      const active = (await client.query("SELECT count(*)::int AS n FROM m1.plans WHERE workspace_id=$1 AND source_mode='youtube' AND status IN ('QUEUED','RUNNING','WAITING')", [workspace])).rows[0]!.n as number;
      if (active >= limits.max_active_plans) break;
      if ((await client.query("SELECT 1 FROM m1.plans WHERE workspace_id=$1 AND channel_id=$2 AND status IN ('QUEUED','RUNNING','WAITING')", [workspace, channel_id])).rowCount) continue;
      const input = CreatePlanSchema.parse({ request_id: randomUUID(), source_mode: 'youtube', channel_id });
      if (!('source_mode' in input)) continue;
      const units = estimateApiUnits(input.required_domains, input.scope.video_limit), budget = await apiBudget(client, workspace, now, true);
      if (budget.used + budget.reserved + units > limits.api_daily_limit) break;
      const planId = randomUUID(), deadline = new Date(now.getTime() + 120 * 60_000).toISOString();
      const frozen = FrozenInputSchema.parse({ schema_version: CONTRACT_VERSION, source_mode: 'youtube', channel_id, required_domains: input.required_domains,
        scope: input.scope, reference_time: now.toISOString(), deadline_at: deadline, max_attempts: 3 });
      const plan = await this.insertCreatedPlan(client, workspace, input, frozen, contentHash(input), planId, deadline, null);
      await client.query('UPDATE m1.data_api_budget SET reserved_units=reserved_units+$3 WHERE workspace_id=$1 AND quota_day=$2', [workspace, budget.day, units]);
      await client.query('INSERT INTO m1.plan_api_reservations(plan_id,workspace_id,quota_day,remaining) VALUES($1,$2,$3,$4)', [plan.plan_id, workspace, budget.day, units]);
      await client.query("UPDATE m1.channel_imports SET state='planned',plan_id=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2", [workspace, channel_id, plan.plan_id]);
      plans.push(plan);
    }
    return plans;
  }
  /** Bounded scan; the workspace lock makes admission safe across dispatcher replicas. */
  async scheduleUpdates(workspaceId: string, now = new Date()): Promise<Plan[]> {
    return this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('update-admission:' || $1))", [workspaceId]);
      await schedulerState(client, workspaceId, this.updateLimits, now);
      if (!this.updateLimits.enabled) return [];
      // Only clocks in auto_domains are scheduled; the others stay due until updated manually.
      const candidates = await client.query(`SELECT c.channel_id,min(k.due_at) AS due FROM m1.channels c JOIN m1.channel_clocks k USING(workspace_id,channel_id)
        WHERE c.workspace_id=$1 AND c.management_state='managed' AND k.due_at<=$2 AND k.clock=ANY($3::text[])
          AND (k.last_scheduled_at IS NULL OR k.last_scheduled_at<date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND (k.last_attempt_at IS NULL OR k.last_attempt_at<date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND NOT EXISTS(SELECT 1 FROM m1.plans p WHERE p.workspace_id=c.workspace_id AND p.channel_id=c.channel_id AND p.status IN ('QUEUED','RUNNING','WAITING'))
        GROUP BY c.channel_id ORDER BY due,c.channel_id LIMIT 25`, [workspaceId, now, this.updateLimits.auto_domains]);
      const plans: Plan[] = [];
      for (const candidate of candidates.rows) {
        const plan = await this.insertUpdate(client, workspaceId, candidate.channel_id, now);
        if (plan) plans.push(plan);
      }
      // Imported channels take what capacity the updates left, oldest first.
      plans.push(...await this.admitImports(client, workspaceId, now));
      return plans;
    });
  }
  async updateChannel(principal: Principal, channelId: string, raw: unknown): Promise<Plan> {
    requireRole(principal, 'operator');
    const command = ChannelUpdateSchema.parse(raw), requestHash = contentHash({ channelId, command });
    return this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('update-admission:' || $1))", [principal.workspace_id]);
      const old = (await client.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND request_id=$2', [principal.workspace_id, command.request_id])).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new StoreError('CONFLICT', 'Update identity has different input');
        return toPlan(old);
      }
      const plan = await this.insertUpdate(client, principal.workspace_id, channelId, new Date(), { ...command, requestHash });
      if (!plan) throw new StoreError('BUDGET_EXHAUSTED', 'Update admission budget is full; the channel remains due');
      return plan;
    });
  }
  async updates(principal: Principal, limit=20, offset=0, filter: { state?: string; search?: string } = {}) {
    requireRole(principal, 'reader', 'operator');
    return readUpdates(this.pool, principal.workspace_id, this.updateLimits, toPlan, limit, offset, filter);
  }
  private async insertUpdate(client: PoolClient, workspace: string, channelId: string, now: Date,
    manual?: { request_id: string; expected_version: number; domains?: Domain[]; requestHash: string }): Promise<Plan | null> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('channel-plan:' || $1 || ':' || $2))", [workspace, channelId]);
    const channel = (await client.query('SELECT * FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE', [workspace, channelId])).rows[0];
    if (!channel) throw new StoreError('NOT_FOUND', 'Channel not found', 404);
    if (manual && channel.management_version !== manual.expected_version) throw new StoreError('CONFLICT', 'Channel management changed; refresh before updating');
    if (channel.management_state !== 'managed') {
      if (manual) throw new StoreError('CONFLICT', 'Only managed channels can be updated');
      return null;
    }
    const active = await client.query("SELECT 1 FROM m1.plans WHERE workspace_id=$1 AND channel_id=$2 AND status IN ('QUEUED','RUNNING','WAITING')", [workspace, channelId]);
    if (active.rowCount) { if (manual) throw new StoreError('CONFLICT', 'This channel already has an active plan'); return null; }
    const clocks = (await client.query('SELECT * FROM m1.channel_clocks WHERE workspace_id=$1 AND channel_id=$2 ORDER BY clock', [workspace, channelId])).rows;
    const utcStart = Date.parse(now.toISOString().slice(0, 10));
    const due = clocks.filter(k => new Date(k.due_at).getTime() <= now.getTime());
    const domains = manual?.domains ?? CLOCK_NAMES.filter(d => due.some(k => k.clock === d && (manual || (this.updateLimits.auto_domains.includes(d) &&
      (!k.last_scheduled_at || new Date(k.last_scheduled_at).getTime() < utcStart) && (!k.last_attempt_at || new Date(k.last_attempt_at).getTime() < utcStart)))));
    if (!domains.length) { if (manual) throw new StoreError('CONFLICT', 'No channel domain is due; choose a domain explicitly'); return null; }
    const counts = (await client.query(`SELECT count(*) FILTER(WHERE status IN ('QUEUED','RUNNING','WAITING'))::int AS active,
      count(*) FILTER(WHERE status IN ('QUEUED','RUNNING','WAITING') AND 'AGENT'=ANY(required_domains))::int AS agent,
      count(*) FILTER(WHERE plan_kind='UPDATE' AND created_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND created_at<((date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC'))::int AS daily
      FROM m1.plans WHERE workspace_id=$1 AND source_mode='youtube'`, [workspace, now])).rows[0]!;
    const limits = this.updateLimits;
    if (counts.active >= limits.max_active_plans || counts.daily >= limits.daily_plan_limit || (domains.includes('AGENT') && counts.agent >= limits.max_agent_plans)) return null;
    const previous = (await client.query('SELECT frozen_input FROM m1.plans WHERE plan_id=$1', [channel.latest_plan_id])).rows[0]!.frozen_input as FrozenInput;
    if (previous.source_mode !== 'youtube') throw new StoreError('INVALID_REQUEST', 'Only real channels can be updated', 400);
    const units = estimateApiUnits(domains, previous.scope.video_limit), budget = await apiBudget(client, workspace, now, true);
    if (budget.used + budget.reserved + units > limits.api_daily_limit) return null;
    const ids = domains.includes('AGENT') && !domains.includes('VIDEO') ? (await client.query(`SELECT video_id FROM m1.videos
      WHERE workspace_id=$1 AND channel_id=$2 AND NOT coalesce((data->>'unavailable')::boolean,false)
      ORDER BY data->>'published_at' DESC NULLS LAST,video_id LIMIT $3`, [workspace, channelId, previous.scope.video_limit])).rows.map(r => r.video_id as string) : undefined;
    const incremental = domains.includes('VIDEO') ? await this.incrementalVideoInput(client, workspace, channelId, now) : {};
    const deadline = new Date(now.getTime() + 120 * 60_000).toISOString();
    const frozen = FrozenInputSchema.parse({ schema_version: CONTRACT_VERSION, source_mode: 'youtube', plan_kind: 'UPDATE', channel_id: channelId,
      required_domains: domains, scope: previous.scope, reference_time: now.toISOString(), deadline_at: deadline, max_attempts: 3,
      ...(ids ? { agent_video_ids: ids } : {}), ...incremental });
    const id = randomUUID(), dueAt = due.length ? new Date(Math.min(...due.map(k => new Date(k.due_at).getTime()))) : now;
    const row = (await client.query(`INSERT INTO m1.plans(plan_id,run_id,workspace_id,request_id,request_hash,channel_id,source_mode,fixture_id,
      required_domains,status,frozen_input,input_hash,workflow_id,deadline_at,plan_kind,update_trigger,update_due_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'youtube',NULL,$7,'QUEUED',$8,$9,$10,$11,'UPDATE',$12,$13,$14,$14) RETURNING *`,
      [id, randomUUID(), workspace, manual?.request_id ?? randomUUID(), manual?.requestHash ?? contentHash(frozen), channelId, domains, frozen,
        contentHash(frozen), `m1/${workspace}/${id}`, deadline, manual ? 'MANUAL' : 'SCHEDULED', dueAt, now])).rows[0]!;
    await client.query('INSERT INTO m1.domains(plan_id,domain) SELECT $1,unnest($2::text[])', [id, domains]);
    await client.query('UPDATE m1.channels SET latest_plan_id=$3,latest_plan_revision=$4,updated_at=$5 WHERE workspace_id=$1 AND channel_id=$2', [workspace, channelId, id, row.source_revision, now]);
    await client.query('UPDATE m1.channel_clocks SET last_scheduled_at=$4 WHERE workspace_id=$1 AND channel_id=$2 AND clock=ANY($3::text[])', [workspace, channelId, domains, now]);
    await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'START')", [randomUUID(), id]);
    if (units) {
      await client.query('UPDATE m1.data_api_budget SET reserved_units=reserved_units+$3 WHERE workspace_id=$1 AND quota_day=$2', [workspace, budget.day, units]);
      await client.query('INSERT INTO m1.plan_api_reservations(plan_id,workspace_id,quota_day,remaining) VALUES($1,$2,$3,$4)', [id, workspace, budget.day, units]);
    }
    return toPlan(row);
  }
  /**
   * Re-read counts of the frozen recent videos (legacy applyRecentSampling): each stored video takes the new
   * counts, its change probability learns from the difference, and the plan records what changed for the clocks.
   */
  private async applySamples(client: PoolClient, workspace: string, row: QueryResultRow, frozen: FrozenInput, samples: VideoSamples, submissionId: string, targets: string[] | null): Promise<void> {
    const planned = frozen.source_mode === 'youtube' ? frozen.recent_sampling?.video_ids ?? null : null;
    if (planned === null) throw new StoreError('TARGET_MISMATCH','Recent videos are re-read only by incremental updates');
    if (!targets) throw new StoreError('TARGET_MISMATCH','Discover new videos before re-reading recent ones');
    const reported = [...samples.items.map(i => i.video_id), ...samples.missing_video_ids];
    if (reported.length !== planned.length || reported.some(id => !planned.includes(id))) throw new StoreError('TARGET_MISMATCH','Re-read videos differ from the frozen ones');
    if ((await client.query('SELECT 1 FROM m1.plan_video_samples WHERE plan_id=$1',[row.plan_id])).rowCount) throw new StoreError('CONFLICT','Recent videos were already re-read for this plan');
    const stored = new Map((await client.query('SELECT video_id,data,change_probability FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 AND video_id=ANY($3::text[]) FOR UPDATE',
      [workspace, row.channel_id, planned])).rows.map(r => [r.video_id as string, r]));
    const facts = { selected_count: planned.length, success_count: 0, failure_count: samples.missing_video_ids.length, comparable_view_count: 0, view_changed_count: 0, view_delta_total: 0, engagement_changed_count: 0 };
    for (const item of samples.items) {
      const current = stored.get(item.video_id);
      if (!current || isVideoUnavailable(current.data as VideoItem)) { facts.failure_count += 1; continue; }
      const data = current.data as VideoFacts;
      const before = { view_count: resolvedCount(data.view_count), like_count: resolvedCount(data.like_count), comment_count: resolvedCount(data.comment_count) };
      const after = { view_count: item.view_count, like_count: item.like_count, comment_count: data.comments_disabled ? before.comment_count : item.comment_count };
      facts.success_count += 1;
      if (before.view_count !== null && after.view_count !== null) {
        facts.comparable_view_count += 1;
        facts.view_delta_total += after.view_count - before.view_count;
        if (after.view_count !== before.view_count) facts.view_changed_count += 1;
      }
      if ((before.like_count !== null && after.like_count !== null && before.like_count !== after.like_count)
        || (before.comment_count !== null && after.comment_count !== null && before.comment_count !== after.comment_count)) facts.engagement_changed_count += 1;
      const metric = (value: number | null, previous: VideoFacts['view_count']) => value === null ? previous : { value, status: 'exact' as const, source: samples.source, observed_at: samples.observed_at };
      const next: VideoFacts = { ...data, view_count: metric(after.view_count, data.view_count), like_count: metric(after.like_count, data.like_count), comment_count: metric(after.comment_count, data.comment_count) };
      await client.query('UPDATE m1.videos SET data=$4,stats_observed_at=$5,change_probability=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3',
        [workspace, row.channel_id, item.video_id, next, samples.observed_at, nextChangeProbability(before, after, current.change_probability)]);
    }
    await client.query('INSERT INTO m1.plan_video_samples(plan_id,submission_id,facts) VALUES($1,$2,$3)', [row.plan_id, submissionId, facts]);
  }
  /** Discovery stop reason and Recent Sampling counts of an incremental update; undefined for a first collection. */
  private async incrementalVideoResult(client: PoolClient, plan: QueryResultRow, at: Date): Promise<{ stop_reason: string; sampling: SamplingResult } | undefined> {
    const frozen = plan.frozen_input as FrozenInput;
    if (frozen.source_mode !== 'youtube' || frozen.plan_kind !== 'UPDATE') return undefined;
    const manifest = (await client.query('SELECT manifest FROM m1.plan_video_targets WHERE plan_id=$1',[plan.plan_id])).rows[0]?.manifest;
    const facts = (await client.query('SELECT facts FROM m1.plan_video_samples WHERE plan_id=$1',[plan.plan_id])).rows[0]?.facts
      ?? { selected_count: 0, success_count: 0, failure_count: 0, comparable_view_count: 0, view_changed_count: 0, view_delta_total: 0, engagement_changed_count: 0 };
    // The recent pool after this run: known videos published in the last 30 days (legacy recent_count).
    const recent = (await client.query(`SELECT count(*)::int AS n FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 AND NOT coalesce((data->>'unavailable')::boolean,false)
      AND (data->>'published_at')::timestamptz >= ($3::date - $4::int)::timestamp AT TIME ZONE 'UTC'`,[plan.workspace_id,plan.channel_id,at.toISOString().slice(0,10),RECENT_SAMPLING.recentWindowDays])).rows[0]!.n as number;
    return { stop_reason: manifest?.stop_reason ?? 'anchor_matched', sampling: { ...facts, recent_count: recent, stale_ratio: frozen.recent_sampling?.stale_ratio ?? 0 } };
  }
  /**
   * What an incremental Video update freezes (legacy loadDiscoveryAnchors and Recent Sampling): the 20 newest
   * known videos as discovery anchors, and the recent known videos the legacy planner picks for a re-read.
   */
  private async incrementalVideoInput(client: PoolClient, workspace: string, channelId: string, now: Date) {
    const known = `FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 AND NOT coalesce((data->>'unavailable')::boolean,false) AND data->>'published_at' IS NOT NULL`;
    const anchors = (await client.query(`SELECT video_id ${known} ORDER BY (data->>'published_at')::timestamptz DESC,video_id LIMIT 20`, [workspace, channelId])).rows.map(r => r.video_id as string);
    const recent = (await client.query(`SELECT video_id,(data->>'published_at')::timestamptz AS published_at,coalesce(stats_observed_at,(data->>'observed_at')::timestamptz) AS stats_observed_at,change_probability
      ${known} AND (data->>'published_at')::timestamptz >= ($3::date - $4::int)::timestamp AT TIME ZONE 'UTC'`, [workspace, channelId, now.toISOString().slice(0, 10), RECENT_SAMPLING.recentWindowDays])).rows;
    const plan = planRecentSampling(recent.map(r => ({ video_id: r.video_id, published_at: new Date(r.published_at).getTime(),
      stats_observed_at: r.stats_observed_at ? new Date(r.stats_observed_at).getTime() : null, change_probability: r.change_probability })), now.getTime());
    return { discovery_anchor_ids: anchors, recent_sampling: { video_ids: plan.video_ids, stale_ratio: plan.stale_ratio, candidate_count: plan.candidate_count } };
  }
  /** One idempotent permit per actual external API request, shared by all Worker replicas. */
  async dataApiPermit(principal: Principal, raw: unknown, now = new Date()): Promise<DataApiPermit> {
    requireRole(principal, 'worker');
    const command = DataApiPermitRequestSchema.parse(raw);
    return this.tx(async client => {
      const plan = await this.planRow(client, principal, command.plan_id, true);
      if (plan.source_mode !== 'youtube') throw new StoreError('DOMAIN_NOT_REQUIRED', 'Fixture plans do not call the Data API');
      if (plan.execution_epoch !== command.execution_epoch) throw new StoreError('STALE_EXECUTION', 'Execution no longer owns this plan');
      if (plan.input_hash !== command.input_hash) throw new StoreError('INPUT_MISMATCH', 'Frozen input differs');
      if (terminal(plan.status)) throw new StoreError('PLAN_TERMINAL', 'Plan no longer accepts API calls');
      if (new Date(plan.deadline_at).getTime() <= now.getTime()) throw new StoreError('BUDGET_EXHAUSTED', 'Plan deadline reached');
      // Dates as text: node-postgres reads a date as local midnight, which shifts the day off UTC hosts.
      const reservation = (await client.query('SELECT remaining,quota_day::text AS quota_day FROM m1.plan_api_reservations WHERE plan_id=$1 FOR UPDATE', [plan.plan_id])).rows[0];
      const budget = await apiBudget(client, principal.workspace_id, now, true);
      const old = (await client.query('SELECT plan_id,quota_day::text AS quota_day FROM m1.data_api_permits WHERE workspace_id=$1 AND request_id=$2', [principal.workspace_id, command.request_id])).rows[0];
      if (old && old.plan_id !== plan.plan_id) throw new StoreError('CONFLICT', 'Permit identity belongs to another plan');
      if (old && old.quota_day !== budget.day) throw new StoreError('CONFLICT', 'Permit belongs to a previous quota day');
      const reserved = reservation && reservation.quota_day === budget.day && reservation.remaining > 0;
      const granted = !!old || (reserved ? budget.used < this.updateLimits.api_daily_limit : budget.used + budget.reserved < this.updateLimits.api_daily_limit);
      if (granted && !old) {
        await client.query('INSERT INTO m1.data_api_permits(workspace_id,request_id,plan_id,quota_day,granted_at,endpoint) VALUES($1,$2,$3,$4,$5,$6)', [principal.workspace_id, command.request_id, plan.plan_id, budget.day, now, command.endpoint ?? null]);
        await client.query('UPDATE m1.data_api_budget SET used_units=used_units+1,reserved_units=reserved_units-$3 WHERE workspace_id=$1 AND quota_day=$2', [principal.workspace_id, budget.day, reserved ? 1 : 0]);
        if (reserved) await client.query('UPDATE m1.plan_api_reservations SET remaining=remaining-1 WHERE plan_id=$1', [plan.plan_id]);
      }
      return { granted, quota_day: budget.day, reset_at: budget.reset_at, used_units: budget.used + (granted && !old ? 1 : 0), limit: this.updateLimits.api_daily_limit };
    });
  }
  /** A permitted request failed: record why, once (the console's failure breakdown). */
  async dataApiFailure(principal: Principal, raw: unknown): Promise<{ recorded: boolean }> {
    requireRole(principal, 'worker');
    const report = DataApiFailureReportSchema.parse(raw);
    const plan = await this.planRow(this.pool, principal, report.plan_id);
    if (plan.execution_epoch !== report.execution_epoch) throw new StoreError('STALE_EXECUTION', 'Execution no longer owns this plan');
    if (plan.input_hash !== report.input_hash) throw new StoreError('INPUT_MISMATCH', 'Frozen input differs');
    const updated = await this.pool.query('UPDATE m1.data_api_permits SET failure=$4,failed_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2 AND plan_id=$3 AND failure IS NULL',
      [principal.workspace_id, report.request_id, report.plan_id, report.reason]);
    return { recorded: (updated.rowCount ?? 0) > 0 };
  }
  async dataApiSummary(principal: Principal, now = new Date()): Promise<DataApiSummary> {
    requireRole(principal, 'reader', 'operator');
    return readDataApiSummary(this.pool, principal.workspace_id, this.updateLimits.api_daily_limit, now);
  }
  async agentTasks(principal: Principal, limit = 20, offset = 0, state?: string): Promise<Page<AgentTask>> {
    requireRole(principal, 'reader', 'operator');
    const rows = await readAgentTasks(this.pool, principal.workspace_id, limit + 1, offset, state);
    return page(rows, limit, offset);
  }
  async agentSummary(principal: Principal, now = new Date()): Promise<AgentSummary> {
    requireRole(principal, 'reader', 'operator');
    return readAgentSummary(this.pool, principal.workspace_id, now);
  }
  async getInput(principal: Principal, id: string): Promise<PlanInput> {
    // One consistent database snapshot: plan, proofs and receipts never straddle a commit.
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL transaction_timeout = '10s'");
      const row = await this.planRow(client,principal,id);
      const domains = await client.query('SELECT domain,state,completed_at FROM m1.domains WHERE plan_id=$1 ORDER BY domain', [id]);
      const receipts = await client.query('SELECT receipt FROM m1.receipts WHERE plan_id=$1 ORDER BY applied_at LIMIT 300', [id]);
      const targets = await this.videoTargets(client, row);
      await client.query('COMMIT');
      return {plan:toPlan(row), input:row.frozen_input as FrozenInput, domains:domains.rows.map(r => ({domain:r.domain,state:r.state,completed_at:r.completed_at ? iso(r.completed_at) : null} as DomainResult)), receipts:receipts.rows.map(r => r.receipt as Receipt),...(row.trace_context ? {trace_context:row.trace_context as string} : {}),...(targets ? {video_targets:targets} : {})};
    } catch(error) {
      discard = /connection|timeout/i.test((error as Error).message) || /^08/.test((error as {code?:string}).code ?? '');
      if (!discard) await client.query('ROLLBACK').catch(() => {discard=true;});
      throw error;
    }
    finally { client.release(discard); }
  }
  async getPlan(principal: Principal, id: string): Promise<PlanDetail> {
    const context = await this.getInput(principal,id);
    const events = await this.pool.query('SELECT data,created_at FROM m1.events WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
    return {...context, events:events.rows.map(r => ({...r.data,plan_id:id,created_at:iso(r.created_at)} as StoredEvent))};
  }
  // Business views (lists and statistics) take one source mode, real channels by default:
  // fixture plans are integration and failure tests, never business results.
  async listPlans(principal: Principal, limit=20, offset=0, status?: string, mode: SourceMode='youtube'): Promise<Page<Plan>> {
    requireRole(principal,'reader','operator');
    const result = await this.pool.query('SELECT * FROM m1.plans WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) AND source_mode=$5 ORDER BY created_at DESC,plan_id LIMIT $3 OFFSET $4',[principal.workspace_id,status ?? null,limit+1,offset,mode]);
    return page(result.rows.map(toPlan),limit,offset);
  }
  async getReceipt(principal: Principal, submissionId: string): Promise<Receipt> {
    const result = await this.pool.query('SELECT receipt FROM m1.receipts WHERE workspace_id=$1 AND submission_id=$2',[principal.workspace_id,submissionId]);
    if (!result.rowCount) throw new StoreError('NOT_FOUND','Receipt not found',404);
    return result.rows[0]!.receipt as Receipt;
  }
  async apply(principal: Principal, raw: Submission): Promise<Receipt> {
    requireRole(principal,'worker');
    const input = SubmissionSchema.parse(raw);
    if (submissionHash(input) !== input.payload_hash) throw new StoreError('CONFLICT','Submission hash does not match its content');
    return this.tx(async client => {
      const row = await this.planRow(client,principal,input.plan_id,true);
      const previous = await client.query('SELECT receipt,payload_hash FROM m1.receipts WHERE workspace_id=$1 AND submission_id=$2',[principal.workspace_id,input.submission_id]);
      if (previous.rowCount) {
        if (previous.rows[0]!.payload_hash !== input.payload_hash) throw new StoreError('CONFLICT','Submission identity has different content');
        return previous.rows[0]!.receipt as Receipt;
      }
      if (row.execution_epoch !== input.execution_epoch) throw new StoreError('STALE_EXECUTION','Execution generation no longer owns writes');
      if (terminal(row.status)) throw new StoreError('PLAN_TERMINAL','Plan no longer accepts new results');
      if (new Date(row.deadline_at).getTime() <= Date.now()) throw new StoreError('BUDGET_EXHAUSTED','Plan deadline reached');
      if (row.input_hash !== input.input_hash) throw new StoreError('INPUT_MISMATCH','Frozen input differs');
      if (!(row.required_domains as string[]).includes(input.domain)) throw new StoreError('DOMAIN_NOT_REQUIRED','Domain is not required by this plan');
      const frozen = row.frozen_input as FrozenInput;
      if (input.domain === 'AGENT' && frozen.source_mode === 'fixture') throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Fixture plans have no Agent producer');
      const proof = (await client.query('SELECT state FROM m1.domains WHERE plan_id=$1 AND domain=$2',[input.plan_id,input.domain])).rows[0]!;
      if (proof.state === 'APPLIED') throw new StoreError('CONFLICT','Domain already sealed; replay the original submission');
      const receiptCount = await client.query('SELECT count(*)::int AS count FROM m1.receipts WHERE plan_id=$1',[input.plan_id]);
      if (receiptCount.rows[0]!.count >= 300) throw new StoreError('BUDGET_EXHAUSTED','Submission budget exhausted');
      const item = (id:string) => client.query('INSERT INTO m1.plan_items(plan_id,domain,item_id,submission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.plan_id,input.domain,id,input.submission_id]);
      let expected: string[];
      if (input.domain === 'ABOUT') {
        if (input.payload.channel_id !== row.channel_id || (frozen.source_mode === 'fixture' && contentHash(input.payload) !== contentHash(frozen.sample.about))) throw new StoreError('TARGET_MISMATCH','Result does not match the frozen channel target');
        await client.query(`UPDATE m1.channels SET about=$3,about_revision=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND about_revision <= $4`,[principal.workspace_id,row.channel_id,input.payload,row.source_revision]);
        await item(row.channel_id);
        expected = [row.channel_id];
      } else if (input.domain === 'VIDEO') {
        const targets = await this.videoTargets(client,row);
        const incremental = frozen.source_mode === 'youtube' && frozen.plan_kind === 'UPDATE';
        if (input.payload.kind === 'targets') {
          const manifest = input.payload;
          if (frozen.source_mode !== 'youtube') throw new StoreError('TARGET_MISMATCH','Fixture targets are frozen at creation');
          if (incremental) throw new StoreError('TARGET_MISMATCH','An update discovers new videos instead of listing a window');
          if (targets) throw new StoreError('CONFLICT','Video targets are already frozen for this plan');
          const windowStart = new Date(Date.parse(frozen.reference_time) - frozen.scope.max_age_days * 86_400_000).toISOString();
          if (manifest.channel_id !== row.channel_id || manifest.video_ids.length > frozen.scope.video_limit || manifest.window_start !== windowStart
            || manifest.video_ids.some(id => !YoutubeVideoIdSchema.safeParse(id).success)) throw new StoreError('TARGET_MISMATCH','Target manifest is outside the frozen scope');
          await client.query('INSERT INTO m1.plan_video_targets(plan_id,submission_id,manifest) VALUES($1,$2,$3)',[input.plan_id,input.submission_id,manifest]);
          expected = manifest.video_ids;
        } else if (input.payload.kind === 'discovery') {
          // Incremental discovery: the uploads above the first anchor met become this plan's targets.
          const manifest = input.payload, anchors = frozen.source_mode === 'youtube' ? frozen.discovery_anchor_ids ?? [] : [];
          if (!incremental) throw new StoreError('TARGET_MISMATCH','Discovery belongs to incremental updates');
          if (targets) throw new StoreError('CONFLICT','Video targets are already frozen for this plan');
          if (manifest.channel_id !== row.channel_id || (manifest.matched_anchor_id !== null && !anchors.includes(manifest.matched_anchor_id))
            || manifest.video_ids.some(id => anchors.includes(id))) throw new StoreError('TARGET_MISMATCH','Discovery is outside the frozen anchors');
          await client.query('INSERT INTO m1.plan_video_targets(plan_id,submission_id,manifest) VALUES($1,$2,$3)',[input.plan_id,input.submission_id,manifest]);
          expected = manifest.video_ids;
        } else if (input.payload.kind === 'samples') {
          await this.applySamples(client, principal.workspace_id, row, frozen, input.payload, input.submission_id, targets);
          expected = targets ?? [];
        } else {
          if (!targets) throw new StoreError('TARGET_MISMATCH','Video targets must be frozen before video results');
          for (const video of input.payload.items) {
            if (video.channel_id !== row.channel_id || !targets.includes(video.source_content_id)) throw new StoreError('TARGET_MISMATCH','Video is outside the frozen targets');
            if (frozen.source_mode === 'fixture') {
              const sample = frozen.sample.videos.find(v => v.source_content_id === video.source_content_id);
              if (!sample || isVideoUnavailable(video) || contentHash(video) !== contentHash(sample)) throw new StoreError('TARGET_MISMATCH','Video is outside the frozen fixture');
            }
            await client.query(`INSERT INTO m1.videos(workspace_id,channel_id,video_id,source_revision,data) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(workspace_id,channel_id,video_id) DO UPDATE SET data=EXCLUDED.data,source_revision=EXCLUDED.source_revision,updated_at=clock_timestamp()
              WHERE m1.videos.source_revision <= EXCLUDED.source_revision`,[principal.workspace_id,row.channel_id,video.source_content_id,row.source_revision,video]);
            await item(video.source_content_id);
          }
          expected = targets;
        }
      } else {
        const pending = await client.query("SELECT domain FROM m1.domains WHERE plan_id=$1 AND domain IN ('ABOUT','VIDEO') AND state<>'APPLIED'",[input.plan_id]);
        if (pending.rowCount) throw new StoreError('DOMAIN_INCOMPLETE','Agent input domains are not complete');
        const snapshot = await this.agentSnapshot(client,row);
        if (input.payload.channel_id !== row.channel_id || input.payload.input_hash !== snapshot.input_hash) throw new StoreError('INPUT_MISMATCH','Agent input changed; read the input again');
        await client.query(`UPDATE m1.channels SET agent=$3,agent_revision=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND agent_revision <= $4`,[principal.workspace_id,row.channel_id,input.payload,row.source_revision]);
        await item(row.channel_id);
        expected = [row.channel_id];
      }
      if (input.domain_complete) {
        const items = await client.query('SELECT item_id FROM m1.plan_items WHERE plan_id=$1 AND domain=$2',[input.plan_id,input.domain]);
        const applied = new Set(items.rows.map(r => r.item_id));
        if (expected.some(id => !applied.has(id))) throw new StoreError('DOMAIN_INCOMPLETE','Required frozen targets are missing');
        // An incremental Video update is complete only once its recent videos were re-read too.
        const sampled = frozen.source_mode === 'youtube' && (frozen.recent_sampling?.video_ids.length ?? 0) > 0;
        if (input.domain === 'VIDEO' && sampled && !(await client.query('SELECT 1 FROM m1.plan_video_samples WHERE plan_id=$1',[input.plan_id])).rowCount)
          throw new StoreError('DOMAIN_INCOMPLETE','Recent videos have not been re-read');
        await client.query("UPDATE m1.domains SET state='APPLIED',completed_at=clock_timestamp() WHERE plan_id=$1 AND domain=$2",[input.plan_id,input.domain]);
      }
      const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
      const receipt: Receipt = {schema_version:CONTRACT_VERSION,submission_id:input.submission_id,plan_id:input.plan_id,logical_batch_key:input.logical_batch_key,domain:input.domain,payload_hash:input.payload_hash,state:'APPLIED',applied_at:iso(now)};
      await client.query('INSERT INTO m1.receipts(workspace_id,submission_id,plan_id,domain,logical_batch_key,payload_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',[principal.workspace_id,input.submission_id,input.plan_id,input.domain,input.logical_batch_key,input.payload_hash,receipt]);
      const remaining = await client.query("SELECT domain FROM m1.domains WHERE plan_id=$1 AND state <> 'APPLIED'",[input.plan_id]);
      const completed = remaining.rowCount === 0;
      // Only fixture plans wait on an Agent that does not exist; real plans run until settled.
      const waiting = frozen.source_mode === 'fixture' && remaining.rows.every(r => r.domain === 'AGENT');
      await client.query('UPDATE m1.plans SET status=$2,version=version+1,updated_at=clock_timestamp(),finished_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE plan_id=$1',[input.plan_id,completed ? 'COMPLETED' : waiting ? 'WAITING' : 'RUNNING',completed]);
      if (completed) await client.query("INSERT INTO m1.obligations(plan_id,kind) VALUES($1,'FIXTURE_PLAN_SETTLED') ON CONFLICT DO NOTHING",[input.plan_id]);
      if (completed) await this.settleClocks(client,row,'COMPLETED');
      return receipt;
    });
  }
  async cancel(principal: Principal, planId: string, raw: {command_id:string;expected_version:number}): Promise<Plan> {
    requireRole(principal,'operator');
    const command = CancelPlanSchema.parse(raw);
    const hash = contentHash({plan_id:planId,...command});
    return this.tx(async client => {
      const row = await this.planRow(client,principal,planId,true);
      const previous = await client.query('SELECT command_hash,result FROM m1.commands WHERE workspace_id=$1 AND command_id=$2',[principal.workspace_id,command.command_id]);
      if (previous.rowCount) {
        if (previous.rows[0]!.command_hash !== hash) throw new StoreError('CONFLICT','Command identity has different input');
        return previous.rows[0]!.result as Plan;
      }
      if (row.version !== command.expected_version) throw new StoreError('CONFLICT','Plan version changed; refresh before cancelling');
      if (terminal(row.status)) throw new StoreError('PLAN_TERMINAL','Plan has already ended');
      const result = await client.query("UPDATE m1.plans SET status='CANCELLED',version=version+1,execution_epoch=execution_epoch+1,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE plan_id=$1 RETURNING *",[planId]);
      const plan = toPlan(result.rows[0]!);
      await client.query('INSERT INTO m1.commands(workspace_id,command_id,plan_id,command_hash,result) VALUES($1,$2,$3,$4,$5)',[principal.workspace_id,command.command_id,planId,hash,plan]);
      await client.query("UPDATE m1.intents SET state='SKIPPED' WHERE plan_id=$1 AND kind='START' AND state='PENDING'",[planId]);
      await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),planId]);
      await this.settleClocks(client,row,'CANCELLED');
      return plan;
    });
  }
  async heartbeat(principal: Principal, raw: Heartbeat): Promise<Worker> {
    requireRole(principal,'worker');
    const input = HeartbeatSchema.parse(raw);
    if (input.worker_id !== principal.subject) throw new StoreError('FORBIDDEN','Worker identity differs from credential',403);
    const ids=[...new Set(input.running_plan_ids)];
    const owned=await this.pool.query('SELECT plan_id FROM m1.plans WHERE workspace_id=$1 AND plan_id=ANY($2::uuid[])',[principal.workspace_id,ids]);
    if (owned.rowCount!==ids.length) throw new StoreError('NOT_FOUND','Running plan not found',404);
    const result = await this.pool.query(`INSERT INTO m1.workers(workspace_id,worker_id,heartbeat) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,worker_id) DO UPDATE SET heartbeat=EXCLUDED.heartbeat,last_heartbeat_at=clock_timestamp() RETURNING last_heartbeat_at`,[principal.workspace_id,input.worker_id,input]);
    return {...input,last_heartbeat_at:iso(result.rows[0]!.last_heartbeat_at),stale:false,proxy_status:'NOT_CONFIGURED'};
  }
  async event(principal: Principal, planId: string, raw: ExecutionEvent): Promise<{accepted:true}> {
    requireRole(principal,'worker');
    const input = ExecutionEventSchema.parse(raw);
    if (input.worker_id !== principal.subject) throw new StoreError('FORBIDDEN','Worker identity differs from credential',403);
    return this.tx(async client => {
      const row = await this.planRow(client,principal,planId,true);
      const hash = contentHash(input);
      const old = await client.query('SELECT event_hash FROM m1.events WHERE plan_id=$1 AND event_id=$2',[planId,input.event_id]);
      if (old.rowCount) {
        if (old.rows[0]!.event_hash !== hash) throw new StoreError('CONFLICT','Event identity has different content');
        return {accepted:true};
      }
      if (row.execution_epoch !== input.execution_epoch) throw new StoreError('STALE_EXECUTION','Execution generation is stale');
      const count = await client.query('SELECT count(*)::int AS n FROM m1.events WHERE plan_id=$1',[planId]);
      if (count.rows[0]!.n >= 1000) throw new StoreError('BUDGET_EXHAUSTED','Plan diagnostic event budget exhausted');
      await client.query('INSERT INTO m1.events(plan_id,event_id,event_hash,data) VALUES($1,$2,$3,$4)',[planId,input.event_id,hash,input]);
      if (!terminal(row.status) && input.kind === 'FAILED') {
        await client.query("UPDATE m1.plans SET status='FAILED',version=version+1,execution_epoch=execution_epoch+1,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE plan_id=$1",[planId]);
        await client.query("UPDATE m1.intents SET state='SKIPPED' WHERE plan_id=$1 AND kind='START' AND state='PENDING'",[planId]);
        await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),planId]);
        await this.settleClocks(client,row,'FAILED');
      }
      if (!terminal(row.status) && ['STARTED','WAITING'].includes(input.kind)) {
        const status = input.kind === 'WAITING' ? 'WAITING' : 'RUNNING';
        await client.query('UPDATE m1.plans SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE plan_id=$1 AND status<>$2',[planId,status]);
      }
      return {accepted:true};
    });
  }
  async listWorkers(principal: Principal, limit=20, offset=0): Promise<Page<Worker>> {
    requireRole(principal,'reader','operator');
    const rows = await this.pool.query("SELECT *,last_heartbeat_at < clock_timestamp()-($2 * interval '1 second') AS stale FROM m1.workers WHERE workspace_id=$1 ORDER BY worker_id LIMIT $3 OFFSET $4",[principal.workspace_id,WORKER_STALE_SECONDS,limit+1,offset]);
    return page(rows.rows.map(r => ({...r.heartbeat,last_heartbeat_at:iso(r.last_heartbeat_at),stale:r.stale,proxy_status:'NOT_CONFIGURED'} as Worker)),limit,offset);
  }
  async listErrors(principal: Principal, limit=20, offset=0, mode: SourceMode='youtube'): Promise<Page<StoredEvent>> {
    requireRole(principal,'reader','operator');
    const rows = await this.pool.query("SELECT e.* FROM m1.events e JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 AND p.source_mode=$4 AND e.data->>'kind' IN ('ERROR','FAILED') ORDER BY e.created_at DESC,e.event_id LIMIT $2 OFFSET $3",[principal.workspace_id,limit+1,offset,mode]);
    return page(rows.rows.map(r => ({...r.data,plan_id:r.plan_id,created_at:iso(r.created_at)} as StoredEvent)),limit,offset);
  }
  async listChannels(principal: Principal, limit=20, offset=0, mode: SourceMode='youtube'): Promise<Page<ChannelListItem>> {
    requireRole(principal,'reader','operator');
    // Country and subscribers come from the current About facts; stored_videos counts this workspace's video rows.
    const rows = await this.pool.query(`SELECT c.*, p.status AS latest_plan_status, p.source_mode,
        (SELECT count(*)::int FROM m1.videos v WHERE v.workspace_id=c.workspace_id AND v.channel_id=c.channel_id) AS stored_videos,
        (SELECT min(coalesce(k.retry_at,k.due_at)) FROM m1.channel_clocks k WHERE k.workspace_id=c.workspace_id AND k.channel_id=c.channel_id AND k.clock=ANY($5::text[])) AS next_due_at,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('clock',k.clock,'next_due_at',coalesce(k.retry_at,k.due_at),'interval_days',k.interval_days,'retry_at',k.retry_at,'override_days',k.override_days)
           ORDER BY array_position($5::text[],k.clock)),'[]') FROM m1.channel_clocks k WHERE k.workspace_id=c.workspace_id AND k.channel_id=c.channel_id AND k.clock=ANY($5::text[])) AS clocks
      FROM m1.channels c JOIN m1.plans p ON p.plan_id=c.latest_plan_id
      WHERE c.workspace_id=$1 AND p.source_mode=$4 ORDER BY c.updated_at DESC,c.channel_id LIMIT $2 OFFSET $3`,[principal.workspace_id,limit+1,offset,mode,CLOCK_NAMES]);
    return page(rows.rows.map(r => ({channel_id:r.channel_id,title:r.about?.title ?? null,source_mode:r.source_mode,updated_at:iso(r.updated_at),latest_plan_id:r.latest_plan_id,
      country:r.about?.country ?? null, subscriber_count:typeof r.about?.subscriber_count?.value === 'number' ? r.about.subscriber_count.value : null,
      stored_videos:r.stored_videos, latest_plan_status:r.latest_plan_status, management_state:r.management_state ?? null,
      next_due_at:r.management_state === 'managed' && r.next_due_at ? iso(r.next_due_at) : null,
      clocks:['managed','paused'].includes(r.management_state) ? (r.clocks as {clock:ClockName;next_due_at:string;interval_days:number;retry_at:string|null;override_days:number|null}[])
        .map(k => ({...k,next_due_at:iso(k.next_due_at),retry_at:k.retry_at ? iso(k.retry_at) : null})) : []})),limit,offset);
  }
  async getChannel(principal: Principal, channelId: string): Promise<ChannelDetail> {
    requireRole(principal,'reader','operator');
    const row = (await this.pool.query('SELECT * FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2',[principal.workspace_id,channelId])).rows[0];
    if (!row) throw new StoreError('NOT_FOUND','Channel not found',404);
    const videos = await this.pool.query('SELECT data FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 ORDER BY video_id LIMIT 100',[principal.workspace_id,channelId]);
    const latest = toPlan(await this.planRow(this.pool,principal,row.latest_plan_id));
    return {channel_id:channelId,title:row.about?.title ?? null,source_mode:latest.source_mode,updated_at:iso(row.updated_at),latest_plan_id:row.latest_plan_id,about:row.about,videos:videos.rows.map(r=>r.data as VideoItem),agent:row.agent ?? null,latest_plan:latest,
      management:await this.management(this.pool,row)};
  }
  /** Operator command on a real channel's management (see ChannelManagementCommandSchema). */
  async manageChannel(principal: Principal, channelId: string, raw: unknown): Promise<ChannelManagement> {
    requireRole(principal,'operator');
    const command = ChannelManagementCommandSchema.parse(raw);
    return this.tx(async client => {
      const row = (await client.query('SELECT c.*, p.source_mode FROM m1.channels c JOIN m1.plans p ON p.plan_id=c.latest_plan_id WHERE c.workspace_id=$1 AND c.channel_id=$2 FOR UPDATE OF c',[principal.workspace_id,channelId])).rows[0];
      if (!row) throw new StoreError('NOT_FOUND','Channel not found',404);
      if (row.management_version !== command.expected_version) throw new StoreError('CONFLICT','Channel management changed; refresh before editing');
      if (row.source_mode !== 'youtube') throw new StoreError('INVALID_REQUEST','Only real channels can be managed',400);
      const from = row.management_state as string | null;
      const allowed: Record<string, (string | null)[]> = { manage:[null,'removed'], pause:['managed'], resume:['paused'], remove:['managed','paused'] };
      if (!allowed[command.action]!.includes(from)) throw new StoreError('CONFLICT',`Cannot ${command.action} a channel that is ${from ?? 'not managed'}`);
      if (command.action === 'manage' && !row.about) throw new StoreError('DOMAIN_INCOMPLETE','Collect the channel once before managing it');
      const to = { manage:'managed', pause:'paused', resume:'managed', remove:'removed' }[command.action];
      const now = (await client.query(`UPDATE m1.channels SET management_state=$3,management_version=management_version+1,management_changed_at=clock_timestamp()
        WHERE workspace_id=$1 AND channel_id=$2 RETURNING management_changed_at`,[principal.workspace_id,channelId,to])).rows[0]!.management_changed_at as Date;
      if (command.action === 'manage') await this.seedClocks(client,principal.workspace_id,channelId,now,true);
      return this.management(client,{...row,management_state:to,management_version:row.management_version+1,management_changed_at:now});
    });
  }
  /**
   * Pin one clock's interval (or return it to the policy). A pinned clock is due its interval after
   * its last success (or today); returning it to the policy restores the policy's day. Bumps the management version.
   */
  async overrideClock(principal: Principal, channelId: string, raw: unknown): Promise<ChannelManagement> {
    requireRole(principal,'operator');
    const command = ChannelClockOverrideSchema.parse(raw);
    return this.tx(async client => {
      const channel = (await client.query('SELECT * FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE',[principal.workspace_id,channelId])).rows[0];
      if (!channel) throw new StoreError('NOT_FOUND','Channel not found',404);
      if (channel.management_version !== command.expected_version) throw new StoreError('CONFLICT','Channel management changed; refresh before editing');
      if (!['managed','paused'].includes(channel.management_state)) throw new StoreError('CONFLICT','Only managed or paused channels have update clocks');
      const pinned = await client.query('UPDATE m1.channel_clocks SET override_days=$4::int,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2 AND clock=$3',[principal.workspace_id,channelId,command.clock,command.interval_days]);
      if (!pinned.rowCount) throw new StoreError('NOT_FOUND','Clock not found',404);
      await this.seedClocks(client,principal.workspace_id,channelId,(await client.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date);
      const updated = (await client.query('UPDATE m1.channels SET management_version=management_version+1 WHERE workspace_id=$1 AND channel_id=$2 RETURNING *',[principal.workspace_id,channelId])).rows[0]!;
      return this.management(client,updated);
    });
  }
  private async management(client: PoolClient | Pool, channel: QueryResultRow): Promise<ChannelManagement> {
    // A removed channel's clocks are stale history; only managed and paused channels show them.
    const clocks = ['managed','paused'].includes(channel.management_state) ? (await client.query('SELECT * FROM m1.channel_clocks WHERE workspace_id=$1 AND channel_id=$2 AND clock=ANY($3::text[])',[channel.workspace_id,channel.channel_id,CLOCK_NAMES])).rows : [];
    const order = (c: string) => CLOCK_NAMES.indexOf(c as ClockName);
    return { state:channel.management_state ?? null, version:channel.management_version ?? 0, changed_at:channel.management_changed_at ? iso(channel.management_changed_at) : null,
      auto_domains:this.updateLimits.enabled ? CLOCK_NAMES.filter(d => this.updateLimits.auto_domains.includes(d)) : [],
      clocks:clocks.sort((a,b) => order(a.clock)-order(b.clock)).map(k => ({ clock:k.clock, due_at:iso(k.due_at), retry_at:k.retry_at ? iso(k.retry_at) : null, next_due_at:iso(k.retry_at ?? k.due_at),
        interval_days:k.interval_days, reasons:k.reasons?.length ? k.reasons : [k.reason], policy_version:k.policy_version, last_success_at:k.last_success_at ? iso(k.last_success_at) : null,
        last_attempt_at:k.last_attempt_at ? iso(k.last_attempt_at) : null, last_plan_id:k.last_plan_id ?? null, override_days:k.override_days ?? null })) };
  }
  /**
   * Write a channel's clocks from the legacy engine's own state. Without one, or when (re-)managing,
   * the engine starts over from what is stored: the About, videos and Agent profile applied as the
   * channel's first observations (facts collected while it was removed included).
   */
  private async seedClocks(client: PoolClient, workspaceId: string, channelId: string, now: Date, restart = false): Promise<void> {
    if (restart) await client.query('DELETE FROM m1.channel_feature_state WHERE workspace_id=$1 AND channel_id=$2',[workspaceId,channelId]);
    let stored = await loadClocks(client,workspaceId,channelId);
    const activity: ClockActivity = { planId:null, succeeded:{}, attempted:{} };
    if (!stored?.snapshot.clock) {
      const channel = (await client.query('SELECT about,agent FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2',[workspaceId,channelId])).rows[0]!;
      const videos = (await client.query('SELECT data FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2',[workspaceId,channelId])).rows.map(r => r.data as VideoItem);
      const observations: Observation[] = [];
      if (channel.about) observations.push(aboutObservation(channel.about as ChannelFacts));
      if (videos.length) observations.push(videoObservation(Math.max(...videos.map(v => Date.parse(v.observed_at))) * 1000,videos));
      if (channel.agent) observations.push(agentObservation(channel.agent as AgentResult));
      observations.sort((a,b) => a.observed_at - b.observed_at);
      // Facts collected before management count as each clock's last success (shown as "上次").
      for (const o of observations) activity.succeeded[o.kind] = new Date(Math.floor(o.observed_at / 1000));
      stored = await applyObservations(client,workspaceId,channelId,stored,observations);
    }
    await writeClocks(client,workspaceId,channelId,stored,activity,now);
  }
  /**
   * A real plan ended (inside its transaction). Its required domains are applied to the channel's
   * clocks as legacy observations: an applied domain moves its clock by the policy; a domain that was
   * not applied changes nothing, so its clock stays due and the next cycle takes it up again. The
   * first completion of an unmanaged channel puts it under management. Removed channels: untouched.
   */
  private async settleClocks(client: PoolClient, plan: QueryResultRow, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    await releaseApiReservation(client, plan.plan_id);
    await client.query("UPDATE m1.channel_imports SET state=$2,updated_at=clock_timestamp() WHERE plan_id=$1 AND state='planned'", [plan.plan_id, status === 'COMPLETED' ? 'done' : 'failed']);
    if ((plan.frozen_input as FrozenInput).source_mode !== 'youtube') return;
    const channel = (await client.query('SELECT management_state,about,agent FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE',[plan.workspace_id,plan.channel_id])).rows[0];
    if (!channel || channel.management_state === 'removed') return;
    if (channel.management_state === null && status !== 'COMPLETED') return;
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
    const completed = new Map((await client.query("SELECT domain,completed_at FROM m1.domains WHERE plan_id=$1 AND state='APPLIED'",[plan.plan_id])).rows.map(r => [r.domain as Domain, r.completed_at as Date]));
    const activity: ClockActivity = { planId:plan.plan_id, succeeded:{}, attempted:{} }, observations: Observation[] = [];
    for (const domain of CLOCK_NAMES.filter(d => (plan.required_domains as Domain[]).includes(d))) {
      const kind = domain.toLowerCase() as ClockKind, at = completed.get(domain);
      if (!at) {
        observations.push({ kind, observed_at:instantFromDate(now), outcome:'failed', facts:null });
        activity.attempted[kind] = now;
        continue;
      }
      if (domain === 'ABOUT') observations.push(aboutObservation(channel.about as ChannelFacts));
      if (domain === 'AGENT') observations.push(agentObservation(channel.agent as AgentResult, instantFromDate(at)));
      if (domain === 'VIDEO') {
        // First seen: applied by this plan and by no earlier plan of the channel.
        const firstSeen = (await client.query(`SELECT v.data FROM m1.plan_items i JOIN m1.videos v ON v.workspace_id=$2 AND v.channel_id=$3 AND v.video_id=i.item_id
          WHERE i.plan_id=$1 AND i.domain='VIDEO' AND NOT EXISTS (SELECT 1 FROM m1.plan_items e JOIN m1.plans p ON p.plan_id=e.plan_id
            WHERE e.domain='VIDEO' AND e.item_id=i.item_id AND p.workspace_id=$2 AND p.channel_id=$3 AND p.source_revision<$4)
          ORDER BY i.item_id`,[plan.plan_id,plan.workspace_id,plan.channel_id,plan.source_revision])).rows.map(r => r.data as VideoItem);
        observations.push(videoObservation(instantFromDate(at),firstSeen,await this.incrementalVideoResult(client,plan,at)));
      }
      activity.succeeded[kind] = at;
    }
    if (channel.management_state === null) {
      await client.query("UPDATE m1.channels SET management_state='managed',management_version=management_version+1,management_changed_at=$3 WHERE workspace_id=$1 AND channel_id=$2",[plan.workspace_id,plan.channel_id,now]);
    }
    const stored = await applyObservations(client,plan.workspace_id,plan.channel_id,await loadClocks(client,plan.workspace_id,plan.channel_id),observations);
    await writeClocks(client,plan.workspace_id,plan.channel_id,stored,activity,now);
  }
  /** Frozen VIDEO targets: fixed at creation for fixtures, the first accepted manifest for YouTube. */
  private async videoTargets(client: PoolClient | Pool, row: QueryResultRow): Promise<string[] | null> {
    const frozen = row.frozen_input as FrozenInput;
    if (frozen.source_mode === 'fixture') return frozen.target_video_ids;
    const manifest = (await client.query('SELECT manifest FROM m1.plan_video_targets WHERE plan_id=$1',[row.plan_id])).rows[0];
    return manifest ? manifest.manifest.video_ids as string[] : null;
  }
  /** Current facts of this plan's channel and available target videos, in target order. */
  private async agentSnapshot(client: PoolClient | Pool, row: QueryResultRow): Promise<AgentInput> {
    const frozen = row.frozen_input as FrozenInput;
    // An update's Video targets are only its new videos; its Agent reads the newest stored videos, as a first collection does.
    const targets = frozen.source_mode === 'youtube' && !frozen.required_domains.includes('VIDEO') ? frozen.agent_video_ids ?? []
      : frozen.source_mode === 'youtube' && frozen.plan_kind === 'UPDATE' ? (await client.query(`SELECT video_id FROM m1.videos
          WHERE workspace_id=$1 AND channel_id=$2 AND NOT coalesce((data->>'unavailable')::boolean,false)
          ORDER BY (data->>'published_at')::timestamptz DESC NULLS LAST,video_id LIMIT $3`,[row.workspace_id,row.channel_id,frozen.scope.video_limit])).rows.map(r => r.video_id as string)
      : await this.videoTargets(client,row) ?? [];
    const channel = (await client.query('SELECT about FROM m1.channels WHERE workspace_id=$1 AND channel_id=$2',[row.workspace_id,row.channel_id])).rows[0];
    if (!channel?.about) throw new StoreError('DOMAIN_INCOMPLETE','Channel facts are missing');
    const rows = await client.query('SELECT video_id,data FROM m1.videos WHERE workspace_id=$1 AND channel_id=$2 AND video_id=ANY($3::text[])',[row.workspace_id,row.channel_id,targets]);
    const byId = new Map(rows.rows.map(r => [r.video_id as string, r.data as VideoItem]));
    const videos = targets.map(id => byId.get(id)).filter((v): v is VideoItem => !!v && !isVideoUnavailable(v)) as AgentInput['videos'];
    const body = {plan_id:row.plan_id as string,channel_id:row.channel_id as string,about:channel.about,videos};
    return {...body,input_hash:agentInputHash(body)};
  }
  async agentInput(principal: Principal, planId: string): Promise<AgentInput> {
    requireRole(principal,'worker');
    const row = await this.planRow(this.pool,principal,planId);
    if ((row.frozen_input as FrozenInput).source_mode !== 'youtube' || !(row.required_domains as string[]).includes('AGENT')) throw new StoreError('DOMAIN_NOT_REQUIRED','Plan has no Agent domain');
    const pending = await this.pool.query("SELECT domain FROM m1.domains WHERE plan_id=$1 AND domain IN ('ABOUT','VIDEO') AND state<>'APPLIED'",[planId]);
    if (pending.rowCount) throw new StoreError('DOMAIN_INCOMPLETE','Agent input domains are not complete');
    return this.agentSnapshot(this.pool,row);
  }
  async claimIntent(leaseSeconds=30, workspaceId?:string): Promise<Intent | null> {
    return this.tx(async client => {
      const token = randomUUID();
      const rows = await client.query(`WITH candidate AS (
        SELECT i.intent_id FROM m1.intents i WHERE ((i.state='PENDING' AND i.available_at<=clock_timestamp()) OR (i.state='LEASED' AND i.lease_until<clock_timestamp()))
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM m1.plans p WHERE p.plan_id=i.plan_id AND p.workspace_id=$3))
        AND (i.kind='START' OR NOT EXISTS (SELECT 1 FROM m1.intents s WHERE s.plan_id=i.plan_id AND s.kind='START' AND s.state IN ('PENDING','LEASED')))
        ORDER BY i.created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE m1.intents i SET state='LEASED',lease_token=$1,lease_until=clock_timestamp()+($2*interval '1 second'),attempts=attempts+1
        FROM candidate c WHERE i.intent_id=c.intent_id RETURNING i.*`,[token,leaseSeconds,workspaceId ?? null]);
      if (!rows.rowCount) return null;
      const intent = rows.rows[0]!;
      // A skipped START with zero claims proves that no dispatcher could have sent
      // a start RPC. Any previous claim remains ambiguous, even without a run ID.
      const row = (await client.query(`SELECT p.*, EXISTS (
        SELECT 1 FROM m1.intents s WHERE s.plan_id=p.plan_id AND s.kind='START'
        AND s.state='SKIPPED' AND s.attempts=0 AND s.workflow_run_id IS NULL
      ) AS start_never_dispatched FROM m1.plans p WHERE p.plan_id=$1`,[intent.plan_id])).rows[0]!;
      return {intent_id:intent.intent_id,plan_id:intent.plan_id,kind:intent.kind,lease_token:token,attempts:intent.attempts,plan_status:row.status,deadline_at:iso(row.deadline_at),start_never_dispatched:row.start_never_dispatched,...(row.trace_context ? {trace_context:row.trace_context as string} : {}),
        input:{schema_version:CONTRACT_VERSION,plan_id:row.plan_id,workspace_id:row.workspace_id,execution_epoch:row.execution_epoch,input_hash:row.input_hash,workflow_id:row.workflow_id}};
    });
  }
  async finishIntent(intent: Intent, state: 'DONE'|'SKIPPED', workflowRunId: string|null=null): Promise<void> {
    await this.pool.query('UPDATE m1.intents SET state=$3,workflow_run_id=$4,lease_until=NULL WHERE intent_id=$1 AND lease_token=$2 AND state=\'LEASED\'',[intent.intent_id,intent.lease_token,state,workflowRunId]);
  }
  async retryIntent(intent: Intent, message: string): Promise<void> {
    await this.pool.query("UPDATE m1.intents SET state='PENDING',available_at=clock_timestamp()+($3*interval '1 second'),last_error=$4,lease_until=NULL WHERE intent_id=$1 AND lease_token=$2 AND state='LEASED'",[intent.intent_id,intent.lease_token,Math.min(60,2 ** Math.min(intent.attempts,6)),message.slice(0,500)]);
  }
  async expirePlans(limit=20, workspaceId?:string): Promise<number> {
    return this.tx(async client => {
      const rows = await client.query("SELECT * FROM m1.plans WHERE status IN ('QUEUED','RUNNING','WAITING') AND deadline_at<=clock_timestamp() AND ($2::text IS NULL OR workspace_id=$2) ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT $1",[limit,workspaceId ?? null]);
      for (const row of rows.rows) {
        const event: ExecutionEvent = {event_id:randomUUID(),execution_epoch:row.execution_epoch,worker_id:'control-dispatcher',phase:'PLAN_DEADLINE',kind:'FAILED',domain:null,message:'Frozen plan deadline exhausted',error_code:'BUDGET_EXHAUSTED'};
        await client.query('INSERT INTO m1.events(plan_id,event_id,event_hash,data) VALUES($1,$2,$3,$4)',[row.plan_id,event.event_id,contentHash(event),event]);
        await client.query("UPDATE m1.plans SET status='FAILED',version=version+1,execution_epoch=execution_epoch+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE plan_id=$1",[row.plan_id]);
        await client.query("UPDATE m1.intents SET state='SKIPPED' WHERE plan_id=$1 AND kind='START' AND state='PENDING'",[row.plan_id]);
        await client.query("INSERT INTO m1.intents(intent_id,plan_id,kind) VALUES($1,$2,'CANCEL') ON CONFLICT DO NOTHING",[randomUUID(),row.plan_id]);
        await this.settleClocks(client,row,'FAILED');
      }
      return rows.rowCount ?? 0;
    });
  }
  /** Plan statistics for one workspace; see PlansSummary for each figure's basis. */
  async plansSummary(principal: Principal, mode: SourceMode='youtube'): Promise<PlansSummary> {
    requireRole(principal,'reader','operator');
    // One SQL statement gives all cards the same MVCC snapshot and clock, and
    // consumes one pool slot even while concurrent plans change state.
    const row=(await this.pool.query(`
      WITH plans AS MATERIALIZED (SELECT * FROM m1.plans WHERE workspace_id=$1 AND source_mode=$2),
      totals AS (SELECT count(*)::int AS total,
        count(*) FILTER (WHERE created_at>=statement_timestamp()-interval '24 hours')::int AS created_24h,
        count(*) FILTER (WHERE status='COMPLETED' AND finished_at>=statement_timestamp()-interval '24 hours')::int AS completed_24h,
        round(extract(epoch FROM avg(finished_at-created_at) FILTER (WHERE status='COMPLETED' AND finished_at>=statement_timestamp()-interval '24 hours')))::float8 AS avg_seconds FROM plans),
      statuses AS (SELECT status,count(*)::int AS n FROM plans GROUP BY status),
      domains AS (SELECT r.domain,count(*)::int AS required,count(*) FILTER (WHERE d.state='APPLIED')::int AS applied
        FROM plans p CROSS JOIN LATERAL unnest(p.required_domains) AS r(domain)
        LEFT JOIN m1.domains d ON d.plan_id=p.plan_id AND d.domain=r.domain GROUP BY r.domain),
      reasons AS (SELECT coalesce(e.data->>'phase','未上报等待原因') AS reason,count(*)::int AS plans
        FROM plans p LEFT JOIN LATERAL (SELECT data FROM m1.events WHERE plan_id=p.plan_id AND data->>'kind' IN ('WAITING','ERROR') ORDER BY created_at DESC,event_id DESC LIMIT 1) e ON true
        WHERE p.status='WAITING' GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 6)
      SELECT totals.*, statement_timestamp() AS observed,
        coalesce((SELECT jsonb_object_agg(status,n) FROM statuses),'{}') AS statuses,
        coalesce((SELECT jsonb_agg(domains ORDER BY domain) FROM domains),'[]') AS domains,
        coalesce((SELECT jsonb_agg(reasons ORDER BY plans DESC,reason) FROM reasons),'[]') AS reasons FROM totals`,[principal.workspace_id,mode])).rows[0]!;
    const by_status={QUEUED:0,RUNNING:0,WAITING:0,COMPLETED:0,CANCELLED:0,FAILED:0,...row.statuses} as Record<PlanStatus,number>;
    return {observed_at:iso(row.observed),total:row.total,by_status,created_24h:row.created_24h,completed_24h:row.completed_24h,
      avg_completion_seconds_24h:row.avg_seconds,domains:row.domains,
      waiting_reasons:row.reasons.map((r:{reason:string;plans:number})=>({reason:r.reason.slice(0,80),plans:r.plans}))};
  }

  /** One aggregate over the workspace's channels; see Completeness for the basis. */
  async completeness(principal: Principal, mode: SourceMode='youtube'): Promise<Completeness> {
    requireRole(principal,'reader','operator');
    const row = (await this.pool.query(`
      WITH per AS (
        SELECT p.required_domains AS required, c.updated_at,
               coalesce(array_agg(d.domain) FILTER (WHERE d.state='APPLIED' AND d.domain = ANY(p.required_domains)), '{}') AS applied
        FROM m1.channels c JOIN m1.plans p ON p.plan_id = c.latest_plan_id
        LEFT JOIN m1.domains d ON d.plan_id = p.plan_id
        WHERE c.workspace_id = $1 AND p.source_mode = $2 GROUP BY c.channel_id, c.updated_at, p.required_domains)
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE cardinality(applied) = cardinality(required))::int AS complete,
        count(*) FILTER (WHERE cardinality(applied) > 0 AND cardinality(applied) < cardinality(required))::int AS partial,
        count(*) FILTER (WHERE cardinality(applied) = 0)::int AS missing,
        count(*) FILTER (WHERE 'ABOUT' = ANY(required) AND NOT 'ABOUT' = ANY(applied))::int AS about,
        count(*) FILTER (WHERE 'VIDEO' = ANY(required) AND NOT 'VIDEO' = ANY(applied))::int AS video,
        count(*) FILTER (WHERE 'AGENT' = ANY(required) AND NOT 'AGENT' = ANY(applied))::int AS agent,
        max(updated_at) AS latest, clock_timestamp() AS observed
      FROM per`,[principal.workspace_id,mode])).rows[0]!;
    const m = (await this.pool.query(`SELECT count(*) FILTER (WHERE c.management_state='managed')::int AS managed, count(*) FILTER (WHERE c.management_state='paused')::int AS paused,
        count(*) FILTER (WHERE c.management_state='managed' AND (SELECT min(coalesce(k.retry_at,k.due_at)) FROM m1.channel_clocks k
          WHERE k.workspace_id=c.workspace_id AND k.channel_id=c.channel_id AND k.clock=ANY($2::text[])) < clock_timestamp())::int AS overdue
      FROM m1.channels c WHERE c.workspace_id=$1 AND c.management_state IN ('managed','paused')`,[principal.workspace_id,CLOCK_NAMES])).rows[0]!;
    return { basis:'latest_plan_required_domains', observed_at:iso(row.observed), total_channels:row.total, complete:row.complete, partial:row.partial, missing:row.missing,
      missing_by_domain:{ ABOUT:row.about, VIDEO:row.video, AGENT:row.agent }, latest_channel_update_at:row.latest ? iso(row.latest) : null, freshness:'NOT_IMPLEMENTED',
      management:{ managed:m.managed, paused:m.paused, overdue:m.overdue } };
  }
  async businessMetrics(workspaceId:string):Promise<Array<{metric:string;state:string;value:number}>> {
    const result=await this.pool.query(`
      SELECT 'plans' AS metric,status AS state,count(*)::float8 AS value FROM m1.plans WHERE workspace_id=$1 GROUP BY status
      UNION ALL SELECT 'domains',d.domain||'_'||d.state,count(*)::float8 FROM m1.domains d JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 GROUP BY d.domain,d.state
      UNION ALL SELECT 'intents',i.kind||'_'||i.state,count(*)::float8 FROM m1.intents i JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 GROUP BY i.kind,i.state
      UNION ALL SELECT 'receipts','APPLIED',count(*)::float8 FROM m1.receipts WHERE workspace_id=$1
      UNION ALL SELECT 'workers',CASE WHEN last_heartbeat_at<clock_timestamp()-interval '90 seconds' THEN 'STALE' ELSE 'FRESH' END,count(*)::float8 FROM m1.workers WHERE workspace_id=$1 GROUP BY 2
      UNION ALL SELECT 'oldest_intent_seconds','PENDING',coalesce(extract(epoch FROM clock_timestamp()-min(i.created_at)),0)::float8 FROM m1.intents i JOIN m1.plans p USING(plan_id) WHERE p.workspace_id=$1 AND i.state IN ('PENDING','LEASED')`,[workspaceId]);
    return result.rows as Array<{metric:string;state:string;value:number}>;
  }
}
