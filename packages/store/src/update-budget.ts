import type { PoolClient } from 'pg';
import type { UpdateLimits } from '@crawlsystem/contracts';

export async function quotaWindow(client: PoolClient, now: Date) {
  const row = (await client.query(`SELECT ($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date::text AS day,
    ((($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date+1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS reset_at`, [now])).rows[0]!;
  return { day: row.day as string, reset_at: new Date(row.reset_at).toISOString() };
}
export async function apiBudget(client: PoolClient, workspace: string, now: Date, lock = false) {
  const window = await quotaWindow(client, now);
  if (lock) await client.query('INSERT INTO control.data_api_budget(workspace_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING', [workspace, window.day]);
  const row = (await client.query(`SELECT used_units,reserved_units FROM control.data_api_budget WHERE workspace_id=$1 AND quota_day=$2${lock ? ' FOR UPDATE' : ''}`, [workspace, window.day])).rows[0];
  return { ...window, used: Number(row?.used_units ?? 0), reserved: Number(row?.reserved_units ?? 0) };
}
/** Reserve enough for the bounded listing and the maximum Workflow retry count.
 * Unspent units are released at settlement; only actual request permits count as used. */
export function estimateApiUnits(domains: string[], videoLimit: number) {
  return 5 * ((domains.includes('ABOUT') ? 1 : 0) + (domains.includes('VIDEO') ? 20 + Math.ceil(videoLimit / 10) : 0));
}
export async function releaseApiReservation(client: PoolClient, planId: string) {
  const row = (await client.query('DELETE FROM control.plan_api_reservations WHERE plan_id=$1 RETURNING workspace_id,quota_day::text AS quota_day,remaining', [planId])).rows[0];
  if (row) await client.query('UPDATE control.data_api_budget SET reserved_units=reserved_units-$3 WHERE workspace_id=$1 AND quota_day=$2', [row.workspace_id, row.quota_day, row.remaining]);
}
export async function schedulerState(client: PoolClient, workspace: string, limits: UpdateLimits, now?: Date) {
  if (now) await client.query(`INSERT INTO control.update_scheduler_state(workspace_id,limits,last_scan_at) VALUES($1,$2,$3)
    ON CONFLICT(workspace_id) DO UPDATE SET limits=EXCLUDED.limits,last_scan_at=EXCLUDED.last_scan_at`, [workspace, limits, now]);
  return (await client.query('SELECT * FROM control.update_scheduler_state WHERE workspace_id=$1', [workspace])).rows[0];
}
