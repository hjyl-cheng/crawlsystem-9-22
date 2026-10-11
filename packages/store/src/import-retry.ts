import type { PoolClient, QueryResultRow } from 'pg';

export const IMPORT_RETRY_MINUTES = [5, 15, 60] as const;
export const IMPORT_RETRY_CODES = ['UNAVAILABLE', 'INTERNAL_ERROR', 'BUDGET_EXHAUSTED'];
export function importRetry(row: QueryResultRow) {
  return { attempts: row.auto_retry_count, next_at: row.retry_at ? new Date(row.retry_at).toISOString() : null,
    blocked_reason: row.retry_blocked_reason, last_code: row.last_failure_code };
}

/** Runs in the plan's terminal transaction. Duplicate or late events cannot schedule twice. */
export async function settleImport(client: PoolClient, plan: QueryResultRow, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') {
  const row = (await client.query("SELECT auto_retry_count FROM control.channel_imports WHERE plan_id=$1 AND state='planned' FOR UPDATE", [plan.plan_id])).rows[0];
  if (!row) return;
  const event = status === 'FAILED' ? (await client.query("SELECT data->>'error_code' AS code FROM control.events WHERE plan_id=$1 AND data->>'kind'='FAILED' ORDER BY created_at DESC,event_id DESC LIMIT 1", [plan.plan_id])).rows[0] : null;
  const code = event?.code ?? null;
  const blocked = status === 'COMPLETED' ? null : status === 'CANCELLED' ? 'cancelled'
    : !IMPORT_RETRY_CODES.includes(code) ? 'non_retryable' : row.auto_retry_count >= IMPORT_RETRY_MINUTES.length ? 'exhausted' : null;
  await client.query(`UPDATE control.channel_imports SET state=$2,last_failure_code=$3,retry_blocked_reason=$4,
    retry_at=CASE WHEN $2='failed' AND $4::text IS NULL THEN clock_timestamp()+($5*interval '1 minute') END,updated_at=clock_timestamp()
    WHERE plan_id=$1 AND state='planned'`, [plan.plan_id, status === 'COMPLETED' ? 'done' : 'failed', code, blocked, IMPORT_RETRY_MINUTES[row.auto_retry_count] ?? 0]);
}
