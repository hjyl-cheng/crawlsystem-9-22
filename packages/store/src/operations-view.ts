import type { Pool } from 'pg';
import { AgentSummarySchema, AgentTaskSchema, DataApiSummarySchema, type AgentSummary, type AgentTask, type DataApiSummary } from '@crawlsystem/contracts';
import { quotaWindow } from './update-budget.ts';

/** Read-only views for the console's Agent and Data API pages. */

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();

/** Each real plan that requires AGENT, as an Agent task; active tasks first, then the newest. */
const AGENT_TASKS = `WITH task AS (
  SELECT p.plan_id,p.channel_id,c.about->>'title' AS title,c.about->>'country' AS country,
    CASE WHEN p.plan_kind='UPDATE' THEN lower(coalesce(p.update_trigger,'SCHEDULED')) ELSE 'first' END AS trigger,
    p.created_at,p.finished_at,d.completed_at,
    coalesce(ARRAY(SELECT x.domain FROM control.domains x WHERE x.plan_id=p.plan_id AND x.domain IN ('ABOUT','VIDEO') AND x.state<>'APPLIED' ORDER BY x.domain),'{}') AS waiting_on,
    CASE WHEN d.state='APPLIED' THEN 'completed' WHEN p.status IN ('FAILED','CANCELLED','COMPLETED') THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM control.domains x WHERE x.plan_id=p.plan_id AND x.domain IN ('ABOUT','VIDEO') AND x.state<>'APPLIED') THEN 'waiting' ELSE 'running' END AS state,
    e.message,e.error_code,c.management_state,coalesce(c.management_version,0) AS management_version,k.due_at AS next_due_at
  FROM control.plans p JOIN control.domains d ON d.plan_id=p.plan_id AND d.domain='AGENT'
  LEFT JOIN control.channel_overview c ON c.workspace_id=p.workspace_id AND c.channel_id=p.channel_id
  LEFT JOIN control.channel_clocks k ON k.workspace_id=p.workspace_id AND k.channel_id=p.channel_id AND k.clock='AGENT'
  LEFT JOIN LATERAL (SELECT ev.data->>'message' AS message,ev.data->>'error_code' AS error_code FROM control.events ev
    WHERE ev.plan_id=p.plan_id AND (ev.data->>'domain'='AGENT' OR ev.data->>'kind' IN ('ERROR','FAILED')) ORDER BY ev.created_at DESC LIMIT 1) e ON true
  WHERE p.workspace_id=$1 AND p.source_mode='youtube'
)`;

export async function readAgentTasks(pool: Pool, workspace: string, limit: number, offset: number, state?: string): Promise<AgentTask[]> {
  const rows = (await pool.query(`${AGENT_TASKS} SELECT * FROM task WHERE ($2::text IS NULL OR state=$2)
    ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,created_at DESC,plan_id LIMIT $3 OFFSET $4`, [workspace, state ?? null, limit, offset])).rows;
  return rows.map(r => AgentTaskSchema.parse({ ...r, created_at: iso(r.created_at), completed_at: iso(r.completed_at), finished_at: iso(r.finished_at), next_due_at: iso(r.next_due_at),
    message: r.message ?? null, error_code: r.error_code ?? null, management_state: r.management_state ?? null }));
}

export async function readAgentSummary(pool: Pool, workspace: string, now: Date): Promise<AgentSummary> {
  const counts = (await pool.query(`${AGENT_TASKS} SELECT count(*) FILTER(WHERE state='waiting')::int AS waiting,count(*) FILTER(WHERE state='running')::int AS running,
      count(*) FILTER(WHERE state='completed' AND completed_at>$2::timestamptz-interval '24 hours')::int AS completed_24h,
      count(*) FILTER(WHERE state='failed' AND finished_at>$2::timestamptz-interval '24 hours')::int AS failed_24h,
      avg(extract(epoch FROM completed_at-created_at)) FILTER(WHERE state='completed' AND completed_at>$2::timestamptz-interval '24 hours') AS avg_seconds
    FROM task`, [workspace, now])).rows[0]!;
  const models = (await pool.query(`SELECT agent->>'model_version' AS model_version,count(*)::int AS channels FROM control.channel_overview
    WHERE workspace_id=$1 AND agent IS NOT NULL GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 20`, [workspace])).rows;
  return AgentSummarySchema.parse({ observed_at: now.toISOString(), waiting: counts.waiting, running: counts.running, completed_24h: counts.completed_24h, failed_24h: counts.failed_24h,
    avg_seconds_24h: counts.avg_seconds === null ? null : Math.round(Number(counts.avg_seconds)), profiled_channels: models.reduce((n, m) => n + m.channels, 0), model_versions: models });
}

/** Today's quota (Pacific-time day) and the last 24 hours of permitted requests and their failures. */
export async function readDataApiSummary(pool: Pool, workspace: string, limit: number, now: Date): Promise<DataApiSummary> {
  const client = await pool.connect();
  try {
    const window = await quotaWindow(client, now);
    const budget = (await client.query('SELECT used_units,reserved_units FROM control.data_api_budget WHERE workspace_id=$1 AND quota_day=$2', [workspace, window.day])).rows[0];
    const since = `$2::timestamptz-interval '24 hours'`;
    const hourly = (await client.query(`SELECT hour,coalesce(calls,0)::int AS calls,coalesce(failures,0)::int AS failures
      FROM generate_series(date_trunc('hour',${since})+interval '1 hour',date_trunc('hour',$2::timestamptz),interval '1 hour') hour
      LEFT JOIN (SELECT date_trunc('hour',granted_at) AS h,count(*) AS calls,count(failure) AS failures FROM control.data_api_permits
        WHERE workspace_id=$1 AND granted_at>${since} GROUP BY 1) x ON x.h=hour ORDER BY hour`, [workspace, now])).rows;
    const endpoints = (await client.query(`SELECT coalesce(endpoint,'unknown') AS endpoint,count(*)::int AS calls,count(failure)::int AS failures FROM control.data_api_permits
      WHERE workspace_id=$1 AND granted_at>${since} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 10`, [workspace, now])).rows;
    const reasons = (await client.query(`SELECT failure AS reason,count(*)::int AS count FROM control.data_api_permits
      WHERE workspace_id=$1 AND failure IS NOT NULL AND failed_at>${since} GROUP BY 1 ORDER BY 2 DESC,1`, [workspace, now])).rows;
    const recent = (await client.query(`SELECT d.failed_at AS at,d.endpoint,d.failure AS reason,d.plan_id,p.channel_id FROM control.data_api_permits d JOIN control.plans p ON p.plan_id=d.plan_id
      WHERE d.workspace_id=$1 AND d.failure IS NOT NULL ORDER BY d.failed_at DESC LIMIT 20`, [workspace])).rows;
    return DataApiSummarySchema.parse({ observed_at: now.toISOString(), quota_day: window.day, reset_at: window.reset_at, limit,
      used_units: Number(budget?.used_units ?? 0), reserved_units: Number(budget?.reserved_units ?? 0),
      hourly: hourly.map(h => ({ hour: iso(h.hour), calls: h.calls, failures: h.failures })), endpoints, failures_by_reason: reasons,
      recent_failures: recent.map(r => ({ ...r, at: iso(r.at) })) });
  } finally { client.release(); }
}
