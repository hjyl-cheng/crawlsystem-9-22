import type { Pool, PoolClient } from 'pg';
import {
  BUSINESS_CATEGORIES, QUERY_STATES, QueryBindingSchema, QuerySummarySchema, normalizeQueryText,
  type CreateQuery, type DiscoveryLimits, type QueryBinding, type QueryCommand, type QuerySummary,
} from '@crawlsystem/contracts';
import { addCalendarMonths, QUERY_POLICY_VERSION } from './query-clock.ts';
import { runsOverview } from './query-runs.ts';

/** Query terms and their country/category bindings (24.8 §5): add, change, list and bulk import. */

export class DiscoveryError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'STALE_EXECUTION', message: string) { super(message); }
}

export interface BindingInput {
  text: string; country: string; language: string; category: string; priority?: number;
  source_type: string; source_ref: string;
}

/** Bind normalised terms to countries and categories, once each; every source is kept. Returns how many bindings are new. */
export async function upsertBindings(client: PoolClient | Pool, workspace: string, rows: readonly BindingInput[], now = new Date()): Promise<{ created: number; bindings: string[] }> {
  const items = rows.map(r => ({ ...r, text: normalizeQueryText(r.text) })).filter(r => r.text.length > 0 && r.text.length <= 200);
  if (!items.length) return { created: 0, bindings: [] };
  const col = <K extends keyof BindingInput>(key: K) => items.map(r => r[key] ?? null);
  await client.query(`INSERT INTO m1.query_terms(term_id,workspace_id,text) SELECT gen_random_uuid(),$1,t FROM unnest($2::text[]) t ON CONFLICT (workspace_id,text) DO NOTHING`,
    [workspace, [...new Set(items.map(r => r.text))]]);
  const created = await client.query(`INSERT INTO m1.query_bindings(binding_id,workspace_id,term_id,country,language,category,state,next_run_at,priority,policy_version)
    SELECT gen_random_uuid(),$1,t.term_id,r.country,r.language,r.category,'BOOTSTRAP',$7,coalesce(r.priority,0),$8
    FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::int[]) r(text,country,language,category,priority)
    JOIN m1.query_terms t ON t.workspace_id=$1 AND t.text=r.text
    ON CONFLICT (workspace_id,term_id,country,category) DO NOTHING RETURNING binding_id`,
    [workspace, col('text'), col('country'), col('language'), col('category'), items.map(r => r.priority ?? 0), now, QUERY_POLICY_VERSION]);
  // Resolve binding ids first, then insert sources by id (a join of the unnested rows misestimates badly).
  const ids = new Map((await client.query(`SELECT b.binding_id,t.text,b.country,b.category FROM m1.query_bindings b JOIN m1.query_terms t USING (term_id)
    WHERE b.workspace_id=$1 AND t.workspace_id=$1 AND t.text=ANY($2::text[])`, [workspace, [...new Set(items.map(r => r.text))]])).rows
    .map(r => [`${r.text}\u0000${r.country}\u0000${r.category}`, r.binding_id as string]));
  const sourced = items.map(r => ({ id: ids.get(`${r.text}\u0000${r.country}\u0000${r.category}`), type: r.source_type, ref: r.source_ref })).filter(r => r.id);
  await client.query(`INSERT INTO m1.query_sources(binding_id,source_type,source_ref) SELECT * FROM unnest($1::uuid[],$2::text[],$3::text[]) ON CONFLICT DO NOTHING`,
    [sourced.map(r => r.id), sourced.map(r => r.type), sourced.map(r => r.ref)]);
  const bindings = sourced.map(r => r.id!);
  return { created: created.rowCount ?? 0, bindings: [...new Set(bindings)] };
}

/** An operator's query: one binding, BOOTSTRAP and due now unless it already exists (then it only gains the source). */
export async function createQuery(client: PoolClient, workspace: string, actor: string, input: CreateQuery): Promise<QueryBinding> {
  const text = normalizeQueryText(input.text);
  if (!text) throw new DiscoveryError('INVALID_REQUEST', 'Query text is empty after normalisation');
  await upsertBindings(client, workspace, [{ ...input, text, source_type: 'MANUAL', source_ref: actor }]);
  const id = (await client.query(`SELECT b.binding_id FROM m1.query_bindings b JOIN m1.query_terms t USING (term_id)
    WHERE b.workspace_id=$1 AND t.text=$2 AND b.country=$3 AND b.category=$4`, [workspace, text, input.country, input.category])).rows[0]!.binding_id as string;
  return (await listBindings(client, workspace, { id }, 1, 0))[0]!;
}

/** Disable, enable or override the cadence of one binding (version-checked and audited). */
export async function commandQuery(client: PoolClient, workspace: string, actor: string, bindingId: string, command: QueryCommand, now = new Date()): Promise<QueryBinding> {
  const row = (await client.query('SELECT * FROM m1.query_bindings WHERE workspace_id=$1 AND binding_id=$2 FOR UPDATE', [workspace, bindingId])).rows[0];
  if (!row) throw new DiscoveryError('NOT_FOUND', 'Query not found');
  if (row.version !== command.expected_version) throw new DiscoveryError('CONFLICT', 'Query changed; refresh before editing');
  let change: Record<string, unknown>;
  if (command.action === 'disable') {
    if (row.state === 'DISABLED') throw new DiscoveryError('CONFLICT', 'Query is already disabled');
    change = { state: 'DISABLED', next_run_at: null, retry_at: null };
    await client.query(`UPDATE m1.query_runs SET state='CANCELLED',finished_at=$2,worker_id=NULL,lease_expires_at=NULL WHERE binding_id=$1 AND state IN ('PENDING','RUNNING')`, [bindingId, now]);
  } else if (command.action === 'enable') {
    if (row.state !== 'DISABLED') throw new DiscoveryError('CONFLICT', 'Only a disabled query can be enabled');
    change = { state: row.last_success_at ? 'ACTIVE' : 'BOOTSTRAP', next_run_at: now, empty_runs: 0 };
  } else {
    // The next run uses the override's window; a binding that has run moves its next date to match it.
    const base = row.last_success_at ? new Date(row.last_success_at) : null;
    const next = command.cadence && base && ['ACTIVE', 'COOLDOWN'].includes(row.state)
      ? new Date(Math.max(now.getTime(), command.cadence === 'WEEK' ? base.getTime() + 7 * 86_400_000 : addCalendarMonths(base, 1).getTime())) : row.next_run_at;
    change = { cadence_override: command.cadence, next_run_at: next };
  }
  const sets = Object.keys(change).map((key, i) => `${key}=$${i + 3}`).join(',');
  await client.query(`UPDATE m1.query_bindings SET ${sets},version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND binding_id=$2`, [workspace, bindingId, ...Object.values(change)]);
  await client.query('INSERT INTO m1.query_audit(binding_id,version,actor,action,detail) VALUES($1,$2,$3,$4,$5)',
    [bindingId, row.version + 1, actor, command.action, { ...('reason' in command ? { reason: command.reason } : {}), ...('cadence' in command ? { cadence: command.cadence } : {}), from_state: row.state }]);
  return (await listBindings(client, workspace, { id: bindingId }, 1, 0))[0]!;
}

export interface BindingFilter { id?: string; state?: string; category?: string; country?: string; search?: string }

export async function listBindings(client: PoolClient | Pool, workspace: string, filter: BindingFilter, limit: number, offset: number): Promise<QueryBinding[]> {
  const rows = (await client.query(`SELECT b.*,t.text,
      coalesce((SELECT jsonb_agg(jsonb_build_object('type',s.source_type,'ref',s.source_ref) ORDER BY s.created_at) FROM (SELECT * FROM m1.query_sources WHERE binding_id=b.binding_id ORDER BY created_at LIMIT 5) s),'[]') AS sources,
      (SELECT count(*)::int FROM m1.query_sources WHERE binding_id=b.binding_id) AS source_count,
      (SELECT jsonb_build_object('state',r.state,'new_channels',r.new_channels,'qualified_new',r.qualified_new,'finished_at',r.finished_at)
        FROM m1.query_runs r WHERE r.binding_id=b.binding_id ORDER BY r.created_at DESC LIMIT 1) AS last_run
    FROM m1.query_bindings b JOIN m1.query_terms t USING (term_id)
    WHERE b.workspace_id=$1 AND ($2::uuid IS NULL OR b.binding_id=$2) AND ($3::text IS NULL OR b.state=$3) AND ($4::text IS NULL OR b.category=$4)
      AND ($5::text IS NULL OR b.country=$5) AND ($6::text IS NULL OR strpos(t.text,lower($6))>0)
    ORDER BY CASE b.state WHEN 'ACTIVE' THEN 0 WHEN 'BOOTSTRAP' THEN 1 WHEN 'COOLDOWN' THEN 2 WHEN 'DORMANT' THEN 3 ELSE 4 END,b.priority DESC,b.next_run_at NULLS LAST,t.text,b.binding_id
    LIMIT $7 OFFSET $8`, [workspace, filter.id ?? null, filter.state ?? null, filter.category ?? null, filter.country ?? null, filter.search?.trim() || null, limit, offset])).rows;
  const iso = (v: Date | null) => v ? new Date(v).toISOString() : null;
  return rows.map(r => QueryBindingSchema.parse({ binding_id: r.binding_id, text: r.text, country: r.country, language: r.language, category: r.category, state: r.state,
    cadence: r.cadence, cadence_override: r.cadence_override, next_run_at: iso(r.next_run_at), last_success_at: iso(r.last_success_at), empty_runs: r.empty_runs,
    priority: r.priority, sources: r.sources, source_count: r.source_count, version: r.version, created_at: iso(r.created_at),
    last_run: r.last_run ? { ...r.last_run, finished_at: r.last_run.finished_at ? new Date(r.last_run.finished_at).toISOString() : null } : null }));
}

export async function querySummary(pool: Pool, workspace: string, limits: DiscoveryLimits, now = new Date()): Promise<QuerySummary> {
  const states = (await pool.query(`SELECT state,count(*)::int AS n,count(*) FILTER (WHERE state IN ('BOOTSTRAP','ACTIVE','COOLDOWN') AND coalesce(retry_at,next_run_at)<=$2)::int AS due
    FROM m1.query_bindings WHERE workspace_id=$1 GROUP BY 1`, [workspace, now])).rows;
  const byCategory = (await pool.query(`SELECT category,count(*)::int AS bindings FROM m1.query_bindings WHERE workspace_id=$1 AND state<>'DISABLED' GROUP BY 1 ORDER BY 2 DESC,1`, [workspace])).rows;
  const byCountry = (await pool.query(`SELECT country,count(*)::int AS bindings FROM m1.query_bindings WHERE workspace_id=$1 AND state<>'DISABLED' GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 50`, [workspace])).rows;
  const by_state = Object.fromEntries(QUERY_STATES.map(s => [s, states.find(r => r.state === s)?.n ?? 0]));
  return QuerySummarySchema.parse({ observed_at: now.toISOString(), total: states.reduce((n, r) => n + r.n, 0), by_state, due: states.reduce((n, r) => n + r.due, 0),
    by_category: byCategory.filter(r => (BUSINESS_CATEGORIES as readonly string[]).includes(r.category)), by_country: byCountry, ...await runsOverview(pool, workspace, limits, now) });
}
