import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  QueryRunParamsSchema, type DataApiPermit, type DiscoveryLimits, type QueryRunClaim, type QueryRunComplete, type QueryRunPage,
  type QueryRunParams, QueryRunCompleteSchema, QueryRunFailSchema, QueryRunHeartbeatSchema, QueryRunPageSchema, QueryRunPermitFailureSchema, QueryRunPermitRequestSchema,
} from '@crawlsystem/contracts';
import { DiscoveryError } from './discovery.ts';
import { LEGACY_QUERY_POLICY_VERSION, QUERY_POLICY_VERSION, retryAt, runWindow, settleQueryRun } from './query-clock.ts';
import { apiBudget } from './update-budget.ts';

/**
 * Query runs (24.8 §5.2): a Worker claims one frozen search of a due binding under a lease, reports
 * each archived result page and creates unvalidated candidates. The first durable ABOUT observations
 * settle qualification and then the binding clock. Frozen pre-R4 runs retain their Data API path.
 * A failed attempt keeps the run and parameters and retries later; failures never advance the clock.
 */

export const RUN_LEASE_MS = 5 * 60_000;
/** Counted failures before a run is given up; the binding then waits a day before a new run. */
export const MAX_RUN_FAILURES = 5;
const GIVE_UP_WAIT_MS = 86_400_000;
/** Failures that do not count against the run: the Worker stopped, or today's Data API budget ran out. */
const UNCOUNTED = new Set(['interrupted', 'quota']);

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const idle = (idle_reason: NonNullable<QueryRunClaim['idle_reason']>, retry_after_ms: number): QueryRunClaim => ({ run: null, idle_reason, retry_after_ms });

/** The run this Worker attempt holds, locked; anything else (another attempt, cancelled, finished) is stale. */
async function heldRun(client: PoolClient, workspace: string, worker: string, runId: string, attempt: number) {
  const run = (await client.query('SELECT * FROM control.query_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE', [workspace, runId])).rows[0];
  if (!run) throw new DiscoveryError('NOT_FOUND', 'Query run not found');
  if (run.state !== 'RUNNING' || run.worker_id !== worker || run.attempt !== attempt) throw new DiscoveryError('STALE_EXECUTION', 'This attempt no longer holds the query run');
  return run;
}

/** A run that has been given up: the binding stays due but waits a day (a retry time, never a new period). */
async function giveUp(client: PoolClient, bindingIds: string[], now: Date) {
  if (bindingIds.length) await client.query('UPDATE control.query_bindings SET retry_at=$2,updated_at=clock_timestamp() WHERE binding_id=ANY($1::uuid[])', [bindingIds, new Date(now.getTime() + GIVE_UP_WAIT_MS)]);
}

export async function claimRun(client: PoolClient, workspace: string, worker: string, limits: DiscoveryLimits, apiDailyLimit: number, now = new Date()): Promise<QueryRunClaim> {
  if (!limits.enabled) return idle('disabled', 60_000);
  // One claim at a time per workspace, so the limits hold under concurrent Workers.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`query-claim:${workspace}`]);
  // A lease that ran out is a failed attempt of the same run, backing off like any other (retryAt).
  const expired = (await client.query(`UPDATE control.query_runs SET failures=failures+1,worker_id=NULL,lease_expires_at=NULL,last_error='lease_expired',
      retry_at=$2::timestamptz+least(24,power(2,failures))*interval '1 hour',
      state=CASE WHEN failures+1>=$3 THEN 'FAILED' ELSE 'PENDING' END,finished_at=CASE WHEN failures+1>=$3 THEN $2::timestamptz END
    WHERE workspace_id=$1 AND state='RUNNING' AND lease_expires_at<$2 RETURNING binding_id,state`, [workspace, now, MAX_RUN_FAILURES])).rows;
  await giveUp(client, expired.filter(r => r.state === 'FAILED').map(r => r.binding_id), now);
  const load = (await client.query(`SELECT
      (SELECT count(*)::int FROM control.query_runs WHERE workspace_id=$1 AND state='RUNNING') AS running,
      (SELECT count(*)::int FROM control.query_runs WHERE workspace_id=$1 AND created_at>=$2) AS created_today,
      (SELECT count(*)::int FROM control.channel_candidates k WHERE workspace_id=$1 AND (state IN ('DISCOVERED','QUALIFIED')
        OR qualification_state='PENDING' AND state='ADMITTED' AND NOT EXISTS(SELECT 1 FROM control.channel_imports i WHERE i.workspace_id=k.workspace_id AND i.channel_id=k.channel_id AND i.state='queued')))
        + (SELECT count(*)::int FROM control.channel_imports WHERE workspace_id=$1 AND state='queued') AS backlog`, [workspace, startOfUtcDay(now)])).rows[0]!;
  if (load.running >= limits.max_active_runs) return idle('concurrency', 10_000);
  if (load.backlog >= limits.backlog_limit) return idle('backlog', 300_000);
  const lease = new Date(now.getTime() + RUN_LEASE_MS);
  // A run waiting to retry resumes first, with its frozen parameters.
  const retry = (await client.query(`SELECT run_id,params FROM control.query_runs WHERE workspace_id=$1 AND state='PENDING' AND retry_at<=$2 ORDER BY retry_at,run_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [workspace, now])).rows[0];
  if (retry) {
    if (retry.params.policy_version === LEGACY_QUERY_POLICY_VERSION) {
      const budget = await apiBudget(client, workspace, now);
      if (budget.used + budget.reserved + limits.api_reserve >= apiDailyLimit) return idle('api_quota', 600_000);
    }
    const run = (await client.query(`UPDATE control.query_runs SET state='RUNNING',attempt=attempt+1,worker_id=$2,lease_expires_at=$3,retry_at=NULL,started_at=coalesce(started_at,$4)
      WHERE run_id=$1 RETURNING run_id,binding_id,attempt,params`, [retry.run_id, worker, lease, now])).rows[0]!;
    return { run: { run_id: run.run_id, binding_id: run.binding_id, attempt: run.attempt, lease_expires_at: lease.toISOString(), params: QueryRunParamsSchema.parse(run.params) }, idle_reason: null, retry_after_ms: 0 };
  }
  if (load.created_today >= limits.daily_run_limit) return idle('daily_runs', 600_000);
  // Fairness (Q-23): the country and category searched least today first, then priority, then the oldest due.
  const binding = (await client.query(`SELECT b.binding_id,b.country,b.language,b.category,b.state,b.cadence,b.cadence_override,b.empty_runs,t.text
    FROM control.query_bindings b JOIN control.query_terms t USING (term_id)
    LEFT JOIN (SELECT q.country,q.category,count(*)::int AS n FROM control.query_runs r JOIN control.query_bindings q USING (binding_id)
      WHERE r.workspace_id=$1 AND r.created_at>=$3 GROUP BY 1,2) f ON f.country=b.country AND f.category=b.category
    WHERE b.workspace_id=$1 AND b.state IN ('BOOTSTRAP','ACTIVE','COOLDOWN') AND coalesce(b.retry_at,b.next_run_at)<=$2
      AND NOT EXISTS (SELECT 1 FROM control.query_runs o WHERE o.binding_id=b.binding_id AND (o.state IN ('PENDING','RUNNING') OR o.state='SUCCEEDED' AND o.clock_settled_at IS NULL))
    ORDER BY coalesce(f.n,0),b.priority DESC,coalesce(b.retry_at,b.next_run_at),b.binding_id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`, [workspace, now, startOfUtcDay(now)])).rows[0];
  if (!binding) return idle('no_due', 60_000);
  const params: QueryRunParams = QueryRunParamsSchema.parse({ text: binding.text, country: binding.country, language: binding.language, category: binding.category,
    window: runWindow(binding), sort: 'popularity', max_pages: limits.max_pages, continue_min_new: limits.continue_min_new, min_subscribers: limits.min_subscribers, policy_version: QUERY_POLICY_VERSION });
  const runId = randomUUID();
  await client.query(`INSERT INTO control.query_runs(run_id,workspace_id,binding_id,params,state,attempt,worker_id,lease_expires_at,created_at,started_at)
    VALUES($1,$2,$3,$4,'RUNNING',1,$5,$6,$7,$7)`, [runId, workspace, binding.binding_id, params, worker, lease, now]);
  return { run: { run_id: runId, binding_id: binding.binding_id, attempt: 1, lease_expires_at: lease.toISOString(), params }, idle_reason: null, retry_after_ms: 0 };
}

export async function extendLease(client: PoolClient, workspace: string, worker: string, runId: string, raw: unknown, now = new Date()) {
  const { attempt } = QueryRunHeartbeatSchema.parse(raw);
  const lease = new Date(now.getTime() + RUN_LEASE_MS);
  const updated = await client.query(`UPDATE control.query_runs SET lease_expires_at=$5 WHERE workspace_id=$1 AND run_id=$2 AND worker_id=$3 AND attempt=$4 AND state='RUNNING'`, [workspace, runId, worker, attempt, lease]);
  return updated.rowCount ? { active: true, lease_expires_at: lease.toISOString() } : { active: false, lease_expires_at: null };
}

/** One result page: keeps each channel once per run (lineage) and says which are new to the system and whether to read on. */
export async function recordPage(client: PoolClient, workspace: string, worker: string, runId: string, raw: unknown) {
  const page: QueryRunPage = QueryRunPageSchema.parse(raw);
  const run = await heldRun(client, workspace, worker, runId, page.attempt), params = QueryRunParamsSchema.parse(run.params);
  if (page.page > params.max_pages) throw new DiscoveryError('INVALID_REQUEST', 'Page beyond the frozen page limit');
  if(page.raw_reference) {
    if(page.raw_reference.key!==`search/v1/${encodeURIComponent(workspace)}/${runId}/${page.attempt}/page-${page.page}.json.gz`) throw new DiscoveryError('INVALID_REQUEST','Search archive address differs from the run page');
    const prior=(await client.query('SELECT raw_reference FROM control.query_run_pages WHERE run_id=$1 AND attempt=$2 AND page=$3',[runId,page.attempt,page.page])).rows[0];
    if(prior && prior.raw_reference.sha256!==page.raw_reference.sha256) throw new DiscoveryError('CONFLICT','Search page already has a different archived response');
    await client.query('INSERT INTO control.query_run_pages(run_id,attempt,page,raw_reference) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[runId,page.attempt,page.page,page.raw_reference]);
  }
  const order = [...new Map(page.items.map(i => [i.channel_id, i.video_id])).entries()];
  if (order.length) await client.query(`INSERT INTO control.query_run_channels(run_id,channel_id,page,video_id,known_before)
    SELECT $1,u.channel_id,$3,u.video_id,
      EXISTS (SELECT 1 FROM control.channel_overview c WHERE c.workspace_id=$2 AND c.channel_id=u.channel_id)
      OR EXISTS (SELECT 1 FROM control.channel_imports i WHERE i.workspace_id=$2 AND i.channel_id=u.channel_id)
      OR EXISTS (SELECT 1 FROM control.channel_candidates k WHERE k.workspace_id=$2 AND k.channel_id=u.channel_id)
    FROM unnest($4::text[],$5::text[]) u(channel_id,video_id) ON CONFLICT DO NOTHING`, [runId, workspace, page.page, order.map(o => o[0]), order.map(o => o[1])]);
  const fresh = new Set((await client.query('SELECT channel_id FROM control.query_run_channels WHERE run_id=$1 AND channel_id=ANY($2::text[]) AND NOT known_before AND page=$3', [runId, order.map(o => o[0]),page.page])).rows.map(r => r.channel_id as string));
  const newIds = order.map(o => o[0]).filter(id => fresh.has(id));
  return { new_channel_ids: newIds, continue: newIds.length >= params.continue_min_new && page.page < params.max_pages };
}

const resultOf = (run: Record<string, any>, binding: Record<string, any>) => ({ run_id: run.run_id as string, state: 'SUCCEEDED' as const, new_channels: run.new_channels as number, qualified_new: run.qualified_new as number,
  qualification_pending: run.qualification_pending as number,
  binding: { state: binding.state, cadence: binding.cadence, next_run_at: !run.qualification_pending && binding.next_run_at ? new Date(binding.next_run_at).toISOString() : null } });

/** Deferred R4 clock: only first-owner candidates count, and technical failures stay pending. */
export async function settleQualifiedRun(client: PoolClient, workspace: string, runId: string, now = new Date()) {
  const run = (await client.query('SELECT * FROM control.query_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE',[workspace,runId])).rows[0];
  if (!run || run.state !== 'SUCCEEDED' || run.clock_settled_at || run.params.policy_version !== QUERY_POLICY_VERSION) return;
  const counts = (await client.query(`SELECT count(*) FILTER (WHERE qualification_state='PENDING')::int AS pending,
    count(*) FILTER (WHERE qualification_state='PASSED')::int AS qualified FROM control.channel_candidates WHERE workspace_id=$1 AND first_run_id=$2`,[workspace,runId])).rows[0]!;
  await client.query('UPDATE control.query_runs SET qualification_pending=$2,qualified_new=$3 WHERE run_id=$1',[runId,counts.pending,counts.qualified]);
  if (counts.pending) return;
  const binding = (await client.query('SELECT state,cadence,cadence_override,empty_runs FROM control.query_bindings WHERE binding_id=$1 FOR UPDATE',[run.binding_id])).rows[0]!;
  const clock = binding.state === 'DISABLED' ? {...binding,next_run_at:null} : settleQueryRun(binding,counts.qualified,now);
  await client.query(`UPDATE control.query_bindings SET state=$2,cadence=$3,next_run_at=$4,empty_runs=$5,last_success_at=$6,retry_at=NULL,last_run_id=$7,updated_at=clock_timestamp()
    WHERE binding_id=$1`,[run.binding_id,clock.state,clock.cadence,clock.next_run_at,clock.empty_runs,now,runId]);
  await client.query('UPDATE control.query_runs SET clock_settled_at=$2 WHERE run_id=$1',[runId,now]);
}

/** Candidates from the run's new channels, then the binding clock, in one transaction (Q-03); a replay returns the stored result (Q-09). */
export async function completeRun(client: PoolClient, workspace: string, worker: string, runId: string, raw: unknown, now = new Date()) {
  const body: QueryRunComplete = QueryRunCompleteSchema.parse(raw);
  const prior = (await client.query('SELECT * FROM control.query_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE', [workspace, runId])).rows[0];
  if (prior?.state === 'SUCCEEDED' && prior.worker_id === worker && prior.attempt === body.attempt) {
    return resultOf(prior, (await client.query('SELECT state,cadence,next_run_at FROM control.query_bindings WHERE binding_id=$1', [prior.binding_id])).rows[0]!);
  }
  const run = await heldRun(client, workspace, worker, runId, body.attempt), params = QueryRunParamsSchema.parse(run.params);
  if (params.policy_version === QUERY_POLICY_VERSION) {
    if (body.channels.length || body.missing_channel_ids.length) throw new DiscoveryError('INVALID_REQUEST','Web discovery reports identities only; qualification belongs to the first ABOUT step');
    const created = (await client.query(`INSERT INTO control.channel_candidates(workspace_id,channel_id,state,first_run_id,first_binding_id,discovered_at,checked_at,qualification_state,min_subscribers)
      SELECT $1,rc.channel_id,'DISCOVERED',$2,$3,$4,NULL,'PENDING',$5 FROM control.query_run_channels rc
      WHERE rc.run_id=$2 AND NOT rc.known_before
        AND NOT EXISTS (SELECT 1 FROM control.channel_overview c WHERE c.workspace_id=$1 AND c.channel_id=rc.channel_id)
        AND NOT EXISTS (SELECT 1 FROM control.channel_imports i WHERE i.workspace_id=$1 AND i.channel_id=rc.channel_id)
      ON CONFLICT DO NOTHING RETURNING channel_id`,[workspace,runId,run.binding_id,now,params.min_subscribers])).rows;
    const found = (await client.query('SELECT count(*)::int AS n FROM control.query_run_channels WHERE run_id=$1',[runId])).rows[0]!.n;
    await client.query(`UPDATE control.query_runs SET state='SUCCEEDED',finished_at=$2,lease_expires_at=NULL,pages=$3,stop_reason=$4,found_channels=$5,new_channels=$6,qualified_new=0,qualification_pending=$6,last_error=NULL WHERE run_id=$1`,
      [runId,now,body.pages,body.stop_reason,found,created.length]);
    await settleQualifiedRun(client,workspace,runId,now);
    return resultOf((await client.query('SELECT * FROM control.query_runs WHERE run_id=$1',[runId])).rows[0]!,
      (await client.query('SELECT state,cadence,next_run_at FROM control.query_bindings WHERE binding_id=$1',[run.binding_id])).rows[0]!);
  }
  if (params.policy_version !== LEGACY_QUERY_POLICY_VERSION) throw new DiscoveryError('INVALID_REQUEST','Unsupported search policy');
  const expected = new Set((await client.query('SELECT channel_id FROM control.query_run_channels WHERE run_id=$1 AND NOT known_before', [runId])).rows.map(r => r.channel_id as string));
  const reported = [...body.channels.map(c => c.channel_id), ...body.missing_channel_ids];
  if (reported.length !== expected.size || new Set(reported).size !== reported.length || reported.some(id => !expected.has(id))) {
    throw new DiscoveryError('INVALID_REQUEST', 'Report exactly the channels this run found new');
  }
  const rows = [...body.channels.map(c => ({ ...c, state: c.hidden_subscribers || c.subscriber_count === null ? 'UNQUALIFIED' : c.subscriber_count >= params.min_subscribers ? 'QUALIFIED' : 'UNQUALIFIED',
      reason: c.hidden_subscribers || c.subscriber_count === null ? 'hidden_subscribers' : c.subscriber_count >= params.min_subscribers ? null : 'below_threshold' })),
    ...body.missing_channel_ids.map(channel_id => ({ channel_id, title: null, country: null, subscriber_count: null, video_count: null, view_count: null, state: 'UNAVAILABLE', reason: 'not_found' }))];
  const col = <K extends keyof typeof rows[number]>(key: K) => rows.map(r => r[key] ?? null);
  // A channel collected or queued meanwhile is not a candidate; one found by a concurrent run stays that run's.
  const created = rows.length ? (await client.query(`INSERT INTO control.channel_candidates(workspace_id,channel_id,state,reason,title,country,subscriber_count,video_count,view_count,first_run_id,first_binding_id,discovered_at,checked_at)
    SELECT $1,u.channel_id,u.state,u.reason,u.title,u.country,u.subs,u.videos,u.views,$2,$3,$4,$4
    FROM unnest($5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::bigint[],$11::bigint[],$12::bigint[]) u(channel_id,state,reason,title,country,subs,videos,views)
    WHERE NOT EXISTS (SELECT 1 FROM control.channel_overview c WHERE c.workspace_id=$1 AND c.channel_id=u.channel_id)
      AND NOT EXISTS (SELECT 1 FROM control.channel_imports i WHERE i.workspace_id=$1 AND i.channel_id=u.channel_id)
    ON CONFLICT DO NOTHING RETURNING state`, [workspace, runId, run.binding_id, now, col('channel_id'), col('state'), col('reason'), col('title'), col('country'),
      col('subscriber_count'), col('video_count'), col('view_count')])).rows : [];
  const qualified = created.filter(r => r.state === 'QUALIFIED').length;
  const binding = (await client.query('SELECT state,cadence,cadence_override,empty_runs FROM control.query_bindings WHERE binding_id=$1 FOR UPDATE', [run.binding_id])).rows[0]!;
  // A binding disabled while its run was out keeps its manual state; the run's history is still kept.
  const clock = binding.state === 'DISABLED' ? { state: 'DISABLED', cadence: binding.cadence, next_run_at: null, empty_runs: binding.empty_runs } : settleQueryRun(binding, qualified, now);
  const after = (await client.query(`UPDATE control.query_bindings SET state=$2,cadence=$3,next_run_at=$4,empty_runs=$5,last_success_at=$6,retry_at=NULL,last_run_id=$7,updated_at=clock_timestamp()
    WHERE binding_id=$1 RETURNING state,cadence,next_run_at`, [run.binding_id, clock.state, clock.cadence, clock.next_run_at, clock.empty_runs, now, runId])).rows[0]!;
  const found = (await client.query('SELECT count(*)::int AS n FROM control.query_run_channels WHERE run_id=$1', [runId])).rows[0]!.n;
  const done = (await client.query(`UPDATE control.query_runs SET state='SUCCEEDED',finished_at=$2,lease_expires_at=NULL,pages=$3,stop_reason=$4,found_channels=$5,new_channels=$6,qualified_new=$7,last_error=NULL
    ,clock_settled_at=$2 WHERE run_id=$1 RETURNING *`, [runId, now, body.pages, body.stop_reason, found, created.length, qualified])).rows[0]!;
  return resultOf(done, after);
}

/** A failed attempt: retried later on the same run (backing off), or given up after repeated failures. */
export async function failRun(client: PoolClient, workspace: string, worker: string, runId: string, raw: unknown, now = new Date()) {
  const report = QueryRunFailSchema.parse(raw);
  const run = (await client.query('SELECT state,worker_id,attempt,retry_at,failures,binding_id FROM control.query_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE', [workspace, runId])).rows[0];
  if (!run) throw new DiscoveryError('NOT_FOUND', 'Query run not found');
  // Already settled or taken over: nothing to do (idempotent).
  if (run.state !== 'RUNNING' || run.worker_id !== worker || run.attempt !== report.attempt) return { state: run.state, retry_at: run.retry_at ? new Date(run.retry_at).toISOString() : null };
  if(report.evidence_ref && !report.evidence_ref.key.startsWith(`failures/search/${encodeURIComponent(workspace)}/${runId}/${report.attempt}/`))throw new DiscoveryError('INVALID_REQUEST','Evidence is outside this search attempt');
  const failures = run.failures + (UNCOUNTED.has(report.reason) ? 0 : 1);
  if (!report.retryable || failures >= MAX_RUN_FAILURES) {
    await client.query(`UPDATE control.query_runs SET state='FAILED',failures=$2,last_error=$3,finished_at=$4,error_evidence=$5,worker_id=NULL,lease_expires_at=NULL WHERE run_id=$1`, [runId, failures, report.reason, now,report.evidence_ref??null]);
    await giveUp(client, [run.binding_id], now);
    return { state: 'FAILED' as const, retry_at: null };
  }
  const at = report.reason === 'interrupted' ? now : report.reason === 'quota' ? new Date(now.getTime() + 3_600_000) : retryAt(failures, now);
  await client.query(`UPDATE control.query_runs SET state='PENDING',failures=$2,last_error=$3,retry_at=$4,error_evidence=$5,worker_id=NULL,lease_expires_at=NULL WHERE run_id=$1`, [runId, failures, report.reason, at,report.evidence_ref??null]);
  return { state: 'PENDING' as const, retry_at: at.toISOString() };
}

/** One Data API request of a run: counted in the shared daily budget, leaving `api_reserve` units for collection. */
export async function runPermit(client: PoolClient, workspace: string, worker: string, runId: string, raw: unknown, limits: DiscoveryLimits, apiDailyLimit: number, now = new Date()): Promise<DataApiPermit> {
  const command = QueryRunPermitRequestSchema.parse(raw);
  const run = await heldRun(client, workspace, worker, runId, command.attempt);
  if (run.params.policy_version !== LEGACY_QUERY_POLICY_VERSION) throw new DiscoveryError('INVALID_REQUEST','Web discovery does not use the Data API');
  const budget = await apiBudget(client, workspace, now, true);
  const old = (await client.query('SELECT run_id,quota_day::text AS quota_day FROM control.data_api_permits WHERE workspace_id=$1 AND request_id=$2', [workspace, command.request_id])).rows[0];
  if (old && (old.run_id !== runId || old.quota_day !== budget.day)) throw new DiscoveryError('CONFLICT', 'Permit identity belongs to another run or day');
  const granted = !!old || budget.used + budget.reserved + limits.api_reserve < apiDailyLimit;
  if (granted && !old) {
    await client.query('INSERT INTO control.data_api_permits(workspace_id,request_id,run_id,quota_day,granted_at,endpoint) VALUES($1,$2,$3,$4,$5,$6)', [workspace, command.request_id, runId, budget.day, now, command.endpoint]);
    await client.query('UPDATE control.data_api_budget SET used_units=used_units+1 WHERE workspace_id=$1 AND quota_day=$2', [workspace, budget.day]);
  }
  return { granted, quota_day: budget.day, reset_at: budget.reset_at, used_units: budget.used + (granted && !old ? 1 : 0), limit: apiDailyLimit };
}

export async function runPermitFailure(client: PoolClient, workspace: string, runId: string, raw: unknown) {
  const report = QueryRunPermitFailureSchema.parse(raw);
  const updated = await client.query('UPDATE control.data_api_permits SET failure=$4,failed_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2 AND run_id=$3 AND failure IS NULL',
    [workspace, report.request_id, runId, report.reason]);
  return { recorded: (updated.rowCount ?? 0) > 0 };
}

/** Search execution today and the candidate pool, for the Query discovery page. */
export async function runsOverview(client: PoolClient | Pool, workspace: string, limits: DiscoveryLimits, now = new Date()) {
  const r = (await client.query(`SELECT
      count(*) FILTER (WHERE state='RUNNING')::int AS running, count(*) FILTER (WHERE state='PENDING')::int AS pending_retry,
      count(*) FILTER (WHERE state='SUCCEEDED' AND clock_settled_at IS NULL)::int AS pending_qualification,
      count(*) FILTER (WHERE created_at>=$2)::int AS created_today,
      count(*) FILTER (WHERE state='SUCCEEDED' AND finished_at>=$2)::int AS succeeded_today,
      count(*) FILTER (WHERE state='FAILED' AND finished_at>=$2)::int AS failed_today,
      coalesce(sum(new_channels) FILTER (WHERE finished_at>=$2),0)::int AS new_channels_today,
      coalesce(sum(qualified_new) FILTER (WHERE finished_at>=$2),0)::int AS qualified_today,
      (SELECT max(finished_at) FROM control.query_runs WHERE workspace_id=$1 AND finished_at IS NOT NULL AND state='SUCCEEDED') AS last_finished_at
    FROM control.query_runs WHERE workspace_id=$1 AND (state IN ('RUNNING','PENDING') OR state='SUCCEEDED' AND clock_settled_at IS NULL OR created_at>=$2 OR finished_at>=$2)`, [workspace, startOfUtcDay(now)])).rows[0]!;
  const c = (await client.query(`SELECT state,count(*)::int AS n FROM control.channel_candidates WHERE workspace_id=$1 GROUP BY 1`, [workspace])).rows;
  const n = (state: string) => c.find(x => x.state === state)?.n ?? 0;
  return {
    runs: { enabled: limits.enabled, max_active_runs: limits.max_active_runs, daily_run_limit: limits.daily_run_limit, running: r.running, pending_retry: r.pending_retry,
      pending_qualification: r.pending_qualification, created_today: r.created_today, succeeded_today: r.succeeded_today, failed_today: r.failed_today, new_channels_today: r.new_channels_today,
      qualified_today: r.qualified_today, last_finished_at: r.last_finished_at ? new Date(r.last_finished_at).toISOString() : null },
    candidates: { discovered: n('DISCOVERED'), qualified: n('QUALIFIED'), unqualified: n('UNQUALIFIED'), unavailable: n('UNAVAILABLE'), admitted: n('ADMITTED'), rejected: n('REJECTED') },
  };
}
