import type { Pool, QueryResultRow } from 'pg';
import { UpdateLimitsSchema, UpdateSummarySchema, UpdateChannelSchema, type Page, type Plan, type UpdateChannel, type UpdateLimits } from '@crawlsystem/contracts';
import { apiBudget, schedulerState } from './update-budget.ts';

/** One shared SQL view for both global figures and paged rows; API readers never mutate clocks. */
const VIEW = `WITH clock_rows AS (
  SELECT channel_id,min(due_at) AS due_at,max(last_success_at) AS last_success_at,
    coalesce(array_agg(clock ORDER BY clock) FILTER(WHERE due_at<=$2),'{}') AS due_domains,
    coalesce(array_agg(clock ORDER BY clock) FILTER(WHERE due_at<=$2 AND clock=ANY($10::text[])),'{}') AS auto_due,
    bool_or(due_at<=$2 AND clock=ANY($10::text[]) AND (last_scheduled_at IS NULL OR last_scheduled_at<date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      AND (last_attempt_at IS NULL OR last_attempt_at<date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS eligible
  FROM control.channel_clocks WHERE workspace_id=$1 GROUP BY channel_id
), counts AS (
  SELECT count(*) FILTER(WHERE status IN ('QUEUED','RUNNING','WAITING')) AS active,
    count(*) FILTER(WHERE status IN ('QUEUED','RUNNING','WAITING') AND 'AGENT'=ANY(required_domains)) AS agent,
    count(*) FILTER(WHERE plan_kind='UPDATE' AND created_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily
  FROM control.plans WHERE workspace_id=$1 AND source_mode='youtube'
), view AS (
  SELECT c.channel_id,c.about->>'title' AS title,c.about->>'country' AS country,c.management_version,k.due_at,k.last_success_at,k.due_domains,
    a.plan_id AS active_plan_id,to_jsonb(p) AS plan,e.data || jsonb_build_object('plan_id',e.plan_id,'created_at',e.created_at) AS event,
    CASE WHEN a.plan_kind='UPDATE' AND a.status='QUEUED' THEN 'queued'
      WHEN a.plan_kind='UPDATE' THEN 'running'
      WHEN cardinality(k.due_domains)>0 AND p.status IN ('FAILED','CANCELLED') THEN 'failed'
      WHEN cardinality(k.due_domains)>0 THEN 'due'
      WHEN p.status='COMPLETED' THEN 'completed' ELSE 'scheduled' END AS state,
    CASE WHEN cardinality(k.due_domains)=0 OR a.plan_kind='UPDATE' THEN NULL
      WHEN a.plan_id IS NOT NULL THEN 'active_plan'
      WHEN NOT $3::boolean THEN 'scheduler_disabled'
      WHEN cardinality(k.auto_due)=0 THEN 'manual_only'
      WHEN NOT k.eligible THEN 'attempted_today'
      WHEN counts.daily >= $6 THEN 'daily_plans'
      WHEN $8::int + $9::int + 5 * (CASE WHEN 'ABOUT'=ANY(k.auto_due) THEN 1 ELSE 0 END +
        CASE WHEN 'VIDEO'=ANY(k.auto_due) THEN 20+ceil(coalesce((latest.frozen_input->'scope'->>'video_limit')::numeric,30)/10)::int ELSE 0 END)>$7 THEN 'api_quota'
      WHEN counts.active >= $4 THEN 'concurrency'
      WHEN 'AGENT'=ANY(k.auto_due) AND counts.agent >= $5 THEN 'agent_capacity' ELSE NULL END AS waiting_reason
  FROM control.channel_overview c JOIN clock_rows k USING(channel_id) JOIN control.plans latest ON latest.plan_id=c.latest_plan_id CROSS JOIN counts
  LEFT JOIN LATERAL(SELECT * FROM control.plans WHERE workspace_id=c.workspace_id AND channel_id=c.channel_id AND plan_kind='UPDATE'
    ORDER BY created_at DESC,source_revision DESC LIMIT 1) p ON true
  LEFT JOIN LATERAL(SELECT * FROM control.plans WHERE workspace_id=c.workspace_id AND channel_id=c.channel_id AND status IN ('QUEUED','RUNNING','WAITING')
    ORDER BY created_at DESC LIMIT 1) a ON true
  LEFT JOIN LATERAL(SELECT * FROM control.events WHERE plan_id=coalesce(a.plan_id,p.plan_id) ORDER BY created_at DESC LIMIT 1) e ON true
  WHERE c.workspace_id=$1 AND c.management_state='managed' AND latest.source_mode='youtube'
)`;

export async function readUpdates(pool: Pool, workspace: string, limits: UpdateLimits, toPlan: (row: QueryResultRow) => Plan,
  limit = 20, offset = 0, filter: { state?: string; search?: string } = {}, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL transaction_timeout='10s'");
    const state = await schedulerState(client, workspace, limits);
    // Limits as the scheduler last applied them; defaults fill fields older scans did not record.
    const effective = UpdateLimitsSchema.parse(state?.limits ?? limits);
    const budget = await apiBudget(client, workspace, now);
    const params = [workspace, now, effective.enabled, effective.max_active_plans, effective.max_agent_plans, effective.daily_plan_limit, effective.api_daily_limit, budget.used, budget.reserved, effective.auto_domains];
    const row = (await client.query(`${VIEW} SELECT count(*)::int AS managed,
      count(*) FILTER(WHERE cardinality(due_domains)>0)::int AS due,
      count(*) FILTER(WHERE due_at<date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS overdue,
      count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='running')::int AS running,
      coalesce((SELECT jsonb_agg(x) FROM(SELECT waiting_reason AS reason,count(*)::int AS channels FROM view
        WHERE waiting_reason IS NOT NULL GROUP BY waiting_reason) x),'[]') AS waiting FROM view`, params)).rows[0]!;
    const outcomes = (await client.query(`SELECT count(*) FILTER(WHERE status='COMPLETED' AND finished_at>$2::timestamptz-interval '24 hours')::int AS completed,
      count(*) FILTER(WHERE status='FAILED' AND finished_at>$2::timestamptz-interval '24 hours')::int AS failed,
      count(*) FILTER(WHERE created_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS daily
      FROM control.plans WHERE workspace_id=$1 AND plan_kind='UPDATE'`, [workspace, now])).rows[0]!;
    const rows = (await client.query(`${VIEW} SELECT * FROM view WHERE ($11::text IS NULL OR state=$11)
      AND ($12::text IS NULL OR strpos(lower(coalesce(title,'')||' '||channel_id),lower($12))>0)
      ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 WHEN 'due' THEN 3 ELSE 4 END,due_at,channel_id LIMIT $13 OFFSET $14`,
      [...params, filter.state ?? null, filter.search?.trim() || null, limit + 1, offset])).rows;
    await client.query('COMMIT');
    const summary = UpdateSummarySchema.parse({ observed_at: now.toISOString(), limits: effective, last_scan_at: state?.last_scan_at ? new Date(state.last_scan_at).toISOString() : null,
      managed: row.managed, due: row.due, overdue: row.overdue, queued: row.queued, running: row.running, completed_24h: outcomes.completed, failed_24h: outcomes.failed,
      daily_plans: outcomes.daily, api_quota_day: budget.day, api_used_units: budget.used, api_reserved_units: budget.reserved, api_reset_at: budget.reset_at, waiting: row.waiting });
    const items = rows.slice(0, limit).map(r => UpdateChannelSchema.parse({ ...r, due_at: r.due_at ? new Date(r.due_at).toISOString() : null,
      last_success_at: r.last_success_at ? new Date(r.last_success_at).toISOString() : null, plan: r.plan ? toPlan(r.plan) : null }));
    return { summary, page: { items, next_cursor: rows.length > limit ? String(offset + limit) : null } as Page<UpdateChannel> };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
