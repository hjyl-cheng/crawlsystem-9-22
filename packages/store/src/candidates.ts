import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  BUSINESS_CATEGORIES, CANDIDATE_STATES, CandidateCommandSchema, CandidateSchema, CandidateSummarySchema,
  type Candidate, type CandidateSummary, type DiscoveryLimits,
} from '@crawlsystem/contracts';
import { DiscoveryError } from './discovery.ts';
import { settleQualifiedRun } from './query-runs.ts';

/**
 * New discoveries and historical qualified candidates enter the bounded import queue,
 * a few at a time so operators can still reject what waits. Categories take turns,
 * then known subscribers or discovery time determine order. Operators reject a candidate,
 * or admit one by hand (also below the threshold).
 */

/** Queue imports for candidates just admitted; a failed import of the same channel is queued again. */
async function queueImports(client: PoolClient, workspace: string, channelIds: string[], requestedBy: string, override = false) {
  if (!channelIds.length) return;
  await client.query(`INSERT INTO control.channel_imports(workspace_id,channel_id,requested_by,request_id,discovery_qualification)
    SELECT $1,k.channel_id,$3,$4,CASE WHEN k.qualification_state IS NOT NULL THEN jsonb_build_object('run_id',k.first_run_id,'min_subscribers',k.min_subscribers,'policy_version','r4.about.v1','override',$5::boolean) END
    FROM control.channel_candidates k WHERE k.workspace_id=$1 AND k.channel_id=ANY($2::text[])
    ON CONFLICT(workspace_id,channel_id) DO UPDATE SET state='queued',plan_id=NULL,requested_by=EXCLUDED.requested_by,request_id=EXCLUDED.request_id,discovery_qualification=EXCLUDED.discovery_qualification,requested_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE control.channel_imports.state IN ('failed','rejected')`, [workspace, channelIds, requestedBy, randomUUID(),override]);
}

/** Top the import queue up to `import_buffer` from qualified candidates; returns the channels admitted. */
export async function admitCandidates(client: PoolClient, workspace: string, limits: DiscoveryLimits, now = new Date()): Promise<string[]> {
  if (!limits.auto_admit) return [];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`candidate-admit:${workspace}`]);
  const queued = (await client.query(`SELECT count(*)::int AS n FROM control.channel_imports WHERE workspace_id=$1 AND state='queued'`, [workspace])).rows[0]!.n;
  const room = limits.import_buffer - queued;
  if (room <= 0) return [];
  // Categories take turns: a category's next candidate waits behind those it already had admitted in
  // the last week; within a category, more subscribers first.
  const picked = (await client.query(`SELECT channel_id FROM (
      SELECT k.channel_id,k.subscriber_count,coalesce(a.n,0)+row_number() OVER (PARTITION BY b.category ORDER BY k.subscriber_count DESC NULLS LAST,k.discovered_at,k.channel_id) AS turn
      FROM control.channel_candidates k JOIN control.query_bindings b ON b.binding_id=k.first_binding_id
      LEFT JOIN (SELECT q.category,count(*)::int AS n FROM control.channel_candidates c JOIN control.query_bindings q ON q.binding_id=c.first_binding_id
        WHERE c.workspace_id=$1 AND c.state='ADMITTED' AND c.decided_at>=$3::timestamptz-interval '7 days' GROUP BY 1) a ON a.category=b.category
      WHERE k.workspace_id=$1 AND k.state IN ('DISCOVERED','QUALIFIED')) k
    ORDER BY turn,subscriber_count DESC NULLS LAST,channel_id LIMIT $2`, [workspace, room, now])).rows.map(r => r.channel_id as string);
  // Only those still qualified: an operator's decision in the meantime wins.
  const admitted = (await client.query(`UPDATE control.channel_candidates SET state='ADMITTED',decided_by='auto',decided_at=$3,decision_reason=NULL,version=version+1
    WHERE workspace_id=$1 AND channel_id=ANY($2::text[]) AND state IN ('DISCOVERED','QUALIFIED') RETURNING channel_id`, [workspace, picked, now])).rows.map(r => r.channel_id as string);
  await queueImports(client, workspace, admitted, 'discovery');
  return admitted;
}

export async function commandCandidate(client: PoolClient, workspace: string, actor: string, channelId: string, raw: unknown, now = new Date()): Promise<Candidate> {
  const command = CandidateCommandSchema.parse(raw);
  const row = (await client.query(`SELECT k.state,k.version,k.qualification_state,k.first_run_id,i.state AS import_state FROM control.channel_candidates k
    LEFT JOIN control.channel_imports i ON i.workspace_id=k.workspace_id AND i.channel_id=k.channel_id WHERE k.workspace_id=$1 AND k.channel_id=$2 FOR UPDATE OF k`, [workspace, channelId])).rows[0];
  if (!row) throw new DiscoveryError('NOT_FOUND', 'Candidate not found');
  if (row.version !== command.expected_version) throw new DiscoveryError('CONFLICT', 'Candidate changed; refresh before deciding');
  if (command.action === 'admit') {
    // An admitted candidate whose first collection failed is admitted again (a retry).
    const retry = row.state === 'ADMITTED' && row.import_state === 'failed';
    if (!retry && !['DISCOVERED','QUALIFIED', 'UNQUALIFIED', 'REJECTED'].includes(row.state)) throw new DiscoveryError('CONFLICT', row.state === 'ADMITTED' ? 'Candidate is already admitted' : 'The channel does not exist on YouTube');
    const override = ['UNQUALIFIED','REJECTED'].includes(row.state);
    if (override && !command.reason?.trim()) throw new DiscoveryError('INVALID_REQUEST','Manual override requires a reason');
    await queueImports(client, workspace, [channelId], actor,override);
  } else {
    if (row.state === 'REJECTED') throw new DiscoveryError('CONFLICT', 'Candidate is already rejected');
    if (row.state === 'ADMITTED') {
      // Active collection cannot be withdrawn; a finished technical failure can be closed explicitly.
      if(row.import_state!=='failed') {
        const withdrawn = await client.query(`DELETE FROM control.channel_imports WHERE workspace_id=$1 AND channel_id=$2 AND state='queued'`, [workspace, channelId]);
        if (!withdrawn.rowCount) throw new DiscoveryError('CONFLICT', 'Collection of this channel has already started');
      }
    }
  }
  await client.query(`UPDATE control.channel_candidates SET state=$3,decided_by=$4,decided_at=$5,decision_reason=$6,version=version+1 WHERE workspace_id=$1 AND channel_id=$2`,
    [workspace, channelId, command.action === 'admit' ? 'ADMITTED' : 'REJECTED', actor, now, command.reason ?? null]);
  if (command.action === 'reject' && row.qualification_state === 'PENDING') {
    await client.query("UPDATE control.channel_candidates SET qualification_state='REJECTED' WHERE workspace_id=$1 AND channel_id=$2",[workspace,channelId]);
    await settleQualifiedRun(client,workspace,row.first_run_id,now);
  }
  return (await listCandidates(client, workspace, { channel_id: channelId }, 1, 0))[0]!;
}

export interface CandidateFilter { channel_id?: string; state?: string; category?: string; search?: string }

export async function listCandidates(client: PoolClient | Pool, workspace: string, filter: CandidateFilter, limit: number, offset: number): Promise<Candidate[]> {
  const rows = (await client.query(`SELECT k.*,b.country AS found_country,b.category,t.text,i.state AS import_state,
      (SELECT count(*)::int FROM control.query_run_channels rc JOIN control.query_runs r USING (run_id) WHERE rc.channel_id=k.channel_id AND r.workspace_id=k.workspace_id) AS found_count
    FROM control.channel_candidates k JOIN control.query_bindings b ON b.binding_id=k.first_binding_id JOIN control.query_terms t ON t.term_id=b.term_id
    LEFT JOIN control.channel_imports i ON i.workspace_id=k.workspace_id AND i.channel_id=k.channel_id
    WHERE k.workspace_id=$1 AND ($2::text IS NULL OR k.channel_id=$2) AND ($3::text IS NULL OR k.state=$3) AND ($4::text IS NULL OR b.category=$4)
      AND ($5::text IS NULL OR k.channel_id=$5 OR strpos(lower(coalesce(k.title,'')),lower($5))>0 OR strpos(t.text,lower($5))>0)
    ORDER BY CASE k.state WHEN 'DISCOVERED' THEN 0 WHEN 'QUALIFIED' THEN 1 WHEN 'ADMITTED' THEN 2 WHEN 'UNQUALIFIED' THEN 3 WHEN 'UNAVAILABLE' THEN 4 ELSE 5 END,
      k.subscriber_count DESC NULLS LAST,k.channel_id
    LIMIT $6 OFFSET $7`, [workspace, filter.channel_id ?? null, filter.state ?? null, filter.category ?? null, filter.search?.trim() || null, limit, offset])).rows;
  const iso = (v: Date | null) => v ? new Date(v).toISOString() : null;
  const num = (v: string | null) => v === null ? null : Number(v);
  return rows.map(r => CandidateSchema.parse({ channel_id: r.channel_id, title: r.title, country: r.country, subscriber_count: num(r.subscriber_count),
    video_count: num(r.video_count), view_count: num(r.view_count), state: r.state, reason: r.reason,
    ...(r.qualification_state ? {qualification:{state:r.qualification_state,min_subscribers:r.min_subscribers}} : {}),
    found_by: { binding_id: r.first_binding_id, text: r.text, country: r.found_country, category: r.category }, found_count: r.found_count,
    discovered_at: iso(r.discovered_at), decided_by: r.decided_by, decided_at: iso(r.decided_at), decision_reason: r.decision_reason,
    import_state: r.import_state, version: r.version }));
}

export async function candidateSummary(pool: Pool, workspace: string, limits: DiscoveryLimits, now = new Date()): Promise<CandidateSummary> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const states = (await pool.query(`SELECT state,count(*)::int AS n,count(*) FILTER (WHERE state='ADMITTED' AND decided_at>=$2)::int AS today
    FROM control.channel_candidates WHERE workspace_id=$1 GROUP BY 1`, [workspace, day])).rows;
  const categories = (await pool.query(`SELECT b.category,count(*) FILTER (WHERE k.state='DISCOVERED')::int AS discovered,count(*) FILTER (WHERE k.state='QUALIFIED')::int AS qualified,count(*) FILTER (WHERE k.state='ADMITTED')::int AS admitted
    FROM control.channel_candidates k JOIN control.query_bindings b ON b.binding_id=k.first_binding_id
    WHERE k.workspace_id=$1 AND k.state IN ('DISCOVERED','QUALIFIED','ADMITTED') GROUP BY 1 ORDER BY 2 DESC,3 DESC,1`, [workspace])).rows;
  const queue = (await pool.query(`SELECT count(*)::int AS n FROM control.channel_imports WHERE workspace_id=$1 AND state='queued'`, [workspace])).rows[0]!.n;
  return CandidateSummarySchema.parse({ observed_at: now.toISOString(), by_state: Object.fromEntries(CANDIDATE_STATES.map(s => [s, states.find(r => r.state === s)?.n ?? 0])),
    admitted_today: states.reduce((n, r) => n + r.today, 0), auto_admit: limits.auto_admit, import_buffer: limits.import_buffer, import_queue: queue,
    by_category: categories.filter(r => (BUSINESS_CATEGORIES as readonly string[]).includes(r.category)) });
}
