import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { MAX_PROXIES_PER_SERVER, ProxyImportSchema, ProxySourceCreateSchema, ProxySourceUpdateSchema, ProxySyncRequestSchema, ProxyUpdateSchema, type Principal, type ProxyAssignment, type ProxyEndpoint, type ProxyExitResult, type ProxyOverview, type ProxySourceView, type ProxyState, type ProxySyncResponse, type ProxyView } from '@crawlsystem/contracts';
import { StoreError, requireRole } from './index.ts';
import type { CredentialBox } from './credentials.ts';

const LEASE_SECONDS = 300;           // a server must re-sync within this window or stop using its proxies
const OBSERVATION_FRESH_SECONDS = 180; // older reports show as unknown, never as healthy
const INVENTORY_LIMIT = 5000;
const UNHEALTHY_QUARANTINE_HOURS = 24; // a subscription may offer an unhealthy-retired endpoint for a new trial after this
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const context = (workspace: string, proxyId: string) => `proxy:${workspace}:${proxyId}`;

/** Central Proxy Control (24.8 §10): inventory, coarse assignment, observed state. */
export class ProxyStore {
  constructor(private pool: Pool, private box?: CredentialBox) {}
  private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '2s'"); await client.query("SET LOCAL statement_timeout = '10s'");
      const result = await action(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  private sealer(): CredentialBox {
    if (!this.box) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED', 'Proxy credential encryption is not configured', 503);
    return this.box;
  }
  /** Upsert by endpoint (protocol, host, port, username). A new password replaces the stored one; an omitted password keeps it. */
  async importProxies(principal: Principal, raw: unknown): Promise<{ created: number; updated: number }> {
    requireRole(principal, 'operator');
    const { entries } = ProxyImportSchema.parse(raw);
    const keys = entries.map(e => `${e.protocol}|${e.host.toLowerCase()}|${e.port}|${e.username ?? ''}`);
    if (new Set(keys).size !== keys.length) throw new StoreError('INVALID_REQUEST', 'Duplicate proxy endpoints in one import', 400);
    if (entries.some(e => e.password !== null)) this.sealer();
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proxies:${principal.workspace_id}`]);
      const count = (await client.query('SELECT count(*)::int AS n FROM control.proxies WHERE workspace_id=$1', [principal.workspace_id])).rows[0]!.n as number;
      let created = 0, updated = 0;
      for (const entry of entries) {
        const existing = (await client.query(`SELECT proxy_id FROM control.proxies WHERE workspace_id=$1 AND protocol=$2 AND lower(host)=lower($3) AND port=$4 AND coalesce(username,'')=$5`,
          [principal.workspace_id, entry.protocol, entry.host, entry.port, entry.username ?? ''])).rows[0];
        const proxyId = existing?.proxy_id as string | undefined ?? randomUUID();
        const credential = entry.password === null ? null : this.box!.seal(entry.password, context(principal.workspace_id, proxyId));
        if (existing) {
          await client.query(`UPDATE control.proxies SET provider=$3,group_name=$4,country_code=$5,kind=$6,max_concurrency=$7,credential=coalesce($8,credential),version=version+1,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND proxy_id=$2`, [principal.workspace_id, proxyId, entry.provider, entry.group, entry.country_code, entry.kind, entry.max_concurrency, credential]);
          updated++;
        } else {
          if (count + created >= INVENTORY_LIMIT) throw new StoreError('BUDGET_EXHAUSTED', `Proxy inventory is limited to ${INVENTORY_LIMIT} endpoints per workspace`);
          await client.query(`INSERT INTO control.proxies(workspace_id,proxy_id,protocol,host,port,username,credential,provider,group_name,country_code,kind,max_concurrency)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [principal.workspace_id, proxyId, entry.protocol, entry.host, entry.port, entry.username, credential, entry.provider, entry.group, entry.country_code, entry.kind, entry.max_concurrency]);
          created++;
        }
      }
      return { created, updated };
    });
  }
  async resources(principal: Principal) {
    requireRole(principal, 'reader', 'operator');
    const rows=(await this.pool.query(`SELECT p.server_id,
      CASE WHEN NOT p.enabled THEN 'disabled' WHEN p.server_id IS NULL THEN 'unassigned'
        WHEN o.reported_at>statement_timestamp()-($2*interval '1 second') AND o.server_id=p.server_id AND o.generation=p.generation THEN o.state
        ELSE 'unknown' END AS state,count(*)::int AS n,
      count(*) FILTER(WHERE p.enabled)::int AS assigned
      FROM control.proxies p LEFT JOIN control.proxy_observations o USING(workspace_id,proxy_id)
      WHERE p.workspace_id=$1 GROUP BY 1,2`,[principal.workspace_id,OBSERVATION_FRESH_SECONDS])).rows;
    const by_state={healthy:0,trial:0,degraded:0,cooldown:0,failed:0,disabled:0,unassigned:0,unknown:0},assignments=new Map<string,number>();
    for(const row of rows){by_state[row.state as ProxyState]+=row.n;if(row.server_id&&row.assigned)assignments.set(row.server_id,(assignments.get(row.server_id)??0)+row.assigned);}
    return {total:rows.reduce((n,r)=>n+r.n,0),by_state,assignments:[...assignments].map(([server_id,assigned])=>({server_id,assigned}))};
  }
  async overview(principal: Principal): Promise<ProxyOverview> {
    requireRole(principal, 'reader', 'operator');
    const rows = (await this.pool.query(`SELECT p.*, o.server_id AS observed_server, o.generation AS observed_generation, o.state AS observed_state, o.cooldown_until, o.last_success_at, o.last_failure_at,
        o.last_error, o.latency_ms, o.observed_at, o.reported_at > clock_timestamp()-($2*interval '1 second') AS fresh,
        coalesce(d.requests,0)::bigint AS requests_today, coalesce(d.failures,0)::bigint AS failures_today, clock_timestamp() AS now, s.name AS source_name
      FROM control.proxies p LEFT JOIN control.proxy_observations o USING (workspace_id, proxy_id) LEFT JOIN control.proxy_sources s ON s.workspace_id=p.workspace_id AND s.source_id=p.source_id
      LEFT JOIN control.proxy_daily d ON d.workspace_id=p.workspace_id AND d.proxy_id=p.proxy_id AND d.day=(clock_timestamp() AT TIME ZONE 'UTC')::date
      WHERE p.workspace_id=$1 ORDER BY p.retired_at NULLS FIRST, (p.server_id IS NULL), p.group_name, p.host, p.port LIMIT $3`, [principal.workspace_id, OBSERVATION_FRESH_SECONDS, INVENTORY_LIMIT])).rows;
    const items = rows.map(r => this.view(r));
    const tally = <K extends string>(keys: K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
    const by_state = tally(['healthy', 'trial', 'degraded', 'cooldown', 'failed', 'disabled', 'unassigned', 'unknown'] as ProxyState[]);
    const providers = new Map<string, { name: string; count: number; requests_today: number; failures_today: number }>(), groups = new Map<string, number>(), countries = new Map<string | null, number>();
    for (const item of items) {
      by_state[item.state]++;
      const p = providers.get(item.provider) ?? { name: item.provider, count: 0, requests_today: 0, failures_today: 0 };
      p.count++; p.requests_today += item.requests_today; p.failures_today += item.failures_today; providers.set(item.provider, p);
      groups.set(item.group, (groups.get(item.group) ?? 0) + 1);
      countries.set(item.exit_country, (countries.get(item.exit_country) ?? 0) + 1);
    }
    const days = (await this.pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, sum(requests)::bigint AS requests, sum(failures)::bigint AS failures FROM control.proxy_daily
      WHERE workspace_id=$1 AND day > (clock_timestamp() AT TIME ZONE 'UTC')::date - 7 GROUP BY day ORDER BY day`, [principal.workspace_id])).rows;
    // Aggregates cover the whole inventory; the list is capped for the page (retired and unassigned last).
    return { observed_at: iso(rows[0]?.now ?? new Date())!, items: items.slice(0, 1000), items_total: items.length, by_state, providers: [...providers.values()].sort((a, b) => b.count - a.count),
      groups: [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      requests_today: items.reduce((n, i) => n + i.requests_today, 0), failures_today: items.reduce((n, i) => n + i.failures_today, 0),
      availability_7d: days.map(d => ({ day: d.day, requests: Number(d.requests), failures: Number(d.failures) })),
      exit_countries: [...countries].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count || String(a.country).localeCompare(String(b.country))).slice(0, 250) };
  }
  private view(r: QueryResultRow): ProxyView {
    // Only a fresh report for the current assignment generation describes the proxy.
    const current = r.observed_state && r.fresh && r.observed_server === r.server_id && Number(r.observed_generation) === Number(r.generation);
    const state: ProxyState = !r.enabled ? 'disabled' : !r.server_id ? 'unassigned' : current ? r.observed_state : 'unknown';
    return { proxy_id: r.proxy_id, protocol: r.protocol, host: r.host, port: r.port, username: r.username, has_password: r.credential !== null,
      provider: r.provider, group: r.group_name, country_code: r.country_code, kind: r.kind, max_concurrency: r.max_concurrency, enabled: r.enabled, version: r.version,
      server_id: r.server_id, source: r.source_name ?? null, retired: r.retired_at != null, retire_reason: r.retired_at != null ? r.retire_reason ?? 'source_missing' : null, tls_insecure: r.tls_insecure === true, state, cooldown_until: current ? iso(r.cooldown_until) : null, last_success_at: iso(r.last_success_at ?? null), last_failure_at: iso(r.last_failure_at ?? null),
      last_error: r.last_error ?? null, requests_today: Number(r.requests_today), failures_today: Number(r.failures_today), latency_ms: current ? r.latency_ms ?? null : null,
      observed_at: iso(r.observed_at ?? null), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
      exit_country: r.exit_country ?? null, exit_ip: r.exit_ip ?? null, exit_checked_at: iso(r.exit_checked_at ?? null),
      exit_check: r.exit_country ? 'ok' : !r.exit_checked_at || r.exit_check_error === 'checking' ? 'pending' : 'failed',
      exit_check_error: r.exit_check_error === 'checking' ? null : r.exit_check_error ?? null };
  }
  /**
   * Proxies whose exit to check next (plan R2): never checked first, then failed ones after a backoff
   * (30 minutes doubling, at most a day), then a recheck a week after success. Retired proxies are
   * checked once and not retried. Claiming stamps the check time, so a crash mid-check only delays the retry.
   */
  async claimExitChecks(workspaceId: string, limit: number): Promise<(ProxyEndpoint & { proxy_id: string })[]> {
    return this.tx(async client => {
      const rows = (await client.query(`UPDATE control.proxies SET exit_checked_at=clock_timestamp(),exit_check_error='checking'
        WHERE (workspace_id,proxy_id) IN (SELECT workspace_id,proxy_id FROM control.proxies
          WHERE workspace_id=$1 AND (exit_checked_at IS NULL OR retired_at IS NULL AND (
            (exit_country IS NOT NULL AND exit_checked_at < clock_timestamp()-interval '7 days')
            OR (exit_country IS NULL AND exit_checked_at < clock_timestamp()-least(interval '24 hours', interval '30 minutes'*power(2,greatest(exit_check_failures-1,0))))))
          ORDER BY exit_checked_at NULLS FIRST,created_at,proxy_id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING proxy_id,protocol,host,port,username,credential,tls_insecure`, [workspaceId, limit])).rows;
      return rows.map(r => ({ proxy_id: r.proxy_id, protocol: r.protocol, host: r.host, port: r.port, username: r.username,
        password: r.credential === null ? null : this.sealer().open(r.credential, context(workspaceId, r.proxy_id)), tls_insecure: r.tls_insecure === true }));
    });
  }
  /** A finished exit check. A failure keeps the last detected country (a proxy may be briefly down). */
  async recordExitCheck(workspaceId: string, proxyId: string, result: ProxyExitResult): Promise<void> {
    if (result.ok) {
      await this.pool.query(`UPDATE control.proxies SET exit_country=$3,exit_ip=$4,exit_checked_at=clock_timestamp(),exit_check_error=NULL,exit_check_failures=0
        WHERE workspace_id=$1 AND proxy_id=$2`, [workspaceId, proxyId, result.country, result.ip]);
    } else {
      await this.pool.query(`UPDATE control.proxies SET exit_checked_at=clock_timestamp(),exit_check_error=$3,exit_check_failures=exit_check_failures+1
        WHERE workspace_id=$1 AND proxy_id=$2`, [workspaceId, proxyId, result.error.slice(0, 40)]);
    }
  }
  /** Enable/disable and (re)assign with a version check. A new server gets a new generation; the old lease is dropped. */
  async update(principal: Principal, proxyId: string, raw: unknown): Promise<ProxyView> {
    requireRole(principal, 'operator');
    const change = ProxyUpdateSchema.parse(raw);
    return this.tx(async client => {
      const row = (await client.query('SELECT * FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2 FOR UPDATE', [principal.workspace_id, proxyId])).rows[0];
      if (!row) throw new StoreError('NOT_FOUND', 'Proxy not found', 404);
      if (row.version !== change.expected_version) throw new StoreError('CONFLICT', 'Proxy changed; refresh before editing');
      const reassign = change.server_id !== undefined && change.server_id !== row.server_id;
      await client.query(`UPDATE control.proxies SET enabled=coalesce($3,enabled), retired_at=CASE WHEN $3 IS NOT NULL THEN NULL ELSE retired_at END,
          retire_reason=CASE WHEN $3 IS NOT NULL THEN NULL ELSE retire_reason END, server_id=CASE WHEN $4 THEN $5 ELSE server_id END,
          generation=generation+CASE WHEN $4 THEN 1 ELSE 0 END, lease_expires_at=CASE WHEN $4 THEN NULL ELSE lease_expires_at END,
          version=version+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND proxy_id=$2`,
        [principal.workspace_id, proxyId, change.enabled ?? null, reassign, change.server_id ?? null]);
      await assertServerCapacity(client, principal.workspace_id, proxyId);
      const updated = (await client.query(`SELECT p.*, NULL AS observed_state, 0::bigint AS requests_today, 0::bigint AS failures_today, (SELECT name FROM control.proxy_sources s WHERE s.workspace_id=p.workspace_id AND s.source_id=p.source_id) AS source_name FROM control.proxies p WHERE workspace_id=$1 AND proxy_id=$2`, [principal.workspace_id, proxyId])).rows[0]!;
      return this.view(updated);
    });
  }
  /** Remove a disabled endpoint (and its observations/counters). Enabled ones must be disabled first. */
  async remove(principal: Principal, proxyId: string, expectedVersion: number): Promise<void> {
    requireRole(principal, 'operator');
    const result = await this.pool.query('DELETE FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2 AND version=$3 AND NOT enabled', [principal.workspace_id, proxyId, expectedVersion]);
    if (result.rowCount) return;
    const row = (await this.pool.query('SELECT enabled FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2', [principal.workspace_id, proxyId])).rows[0];
    if (!row) throw new StoreError('NOT_FOUND', 'Proxy not found', 404);
    throw new StoreError('CONFLICT', row.enabled ? 'Disable the proxy before deleting it' : 'Proxy changed; refresh before deleting');
  }
  /** One round trip per interval from a server's Proxy Manager: report, renew leases, receive assignments. */
  async sync(principal: Principal, raw: unknown): Promise<ProxySyncResponse> {
    requireRole(principal, 'node');
    const server = principal.server_id;
    if (!server) throw new StoreError('FORBIDDEN', 'Node credential has no server identity', 403);
    const report = ProxySyncRequestSchema.parse(raw);
    return this.tx(async client => {
      for (const o of report.observations) {
        // Reports for proxies no longer assigned here (or of an older generation) are ignored, not errors.
        const own = (await client.query('SELECT 1 FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2 AND server_id=$3 AND generation=$4', [principal.workspace_id, o.proxy_id, server, o.generation])).rowCount;
        if (!own) continue;
        const previous = (await client.query('SELECT * FROM control.proxy_observations WHERE workspace_id=$1 AND proxy_id=$2 FOR UPDATE', [principal.workspace_id, o.proxy_id])).rows[0];
        const sameStream = previous && previous.node_boot_id === report.node_boot_id && previous.server_id === server && Number(previous.generation) === o.generation;
        if (sameStream && Number(previous.report_sequence) >= report.report_sequence) continue; // duplicate or out of order
        // Cumulative counters restart with a new boot or assignment; deltas never go negative.
        const requests = sameStream ? Math.max(0, o.requests_total - Number(previous.requests_total)) : o.requests_total;
        const failures = sameStream ? Math.max(0, o.failures_total - Number(previous.failures_total)) : o.failures_total;
        await client.query(`INSERT INTO control.proxy_observations(workspace_id,proxy_id,server_id,generation,state,cooldown_until,last_success_at,last_failure_at,last_error,requests_total,failures_total,latency_ms,node_boot_id,report_sequence,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (workspace_id,proxy_id) DO UPDATE SET server_id=EXCLUDED.server_id,generation=EXCLUDED.generation,state=EXCLUDED.state,cooldown_until=EXCLUDED.cooldown_until,
            last_success_at=EXCLUDED.last_success_at,last_failure_at=EXCLUDED.last_failure_at,last_error=EXCLUDED.last_error,requests_total=EXCLUDED.requests_total,failures_total=EXCLUDED.failures_total,
            latency_ms=EXCLUDED.latency_ms,node_boot_id=EXCLUDED.node_boot_id,report_sequence=EXCLUDED.report_sequence,observed_at=EXCLUDED.observed_at,reported_at=clock_timestamp()`,
          [principal.workspace_id, o.proxy_id, server, o.generation, o.state, o.cooldown_until, o.last_success_at, o.last_failure_at, o.last_error, o.requests_total, o.failures_total, o.latency_ms, report.node_boot_id, report.report_sequence, report.observed_at]);
        // `failed`: three cooldowns on this server without a success in between. Retire it so the
        // slot goes to another endpoint; a subscription may offer it again after the quarantine.
        if (o.state === 'failed') await client.query(`UPDATE control.proxies SET enabled=false, retired_at=clock_timestamp(), retire_reason='unhealthy', server_id=NULL, generation=generation+1,
            lease_expires_at=NULL, version=version+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND proxy_id=$2 AND server_id=$3 AND generation=$4 AND enabled`,
          [principal.workspace_id, o.proxy_id, server, o.generation]);
        if (requests || failures) await client.query(`INSERT INTO control.proxy_daily(workspace_id,proxy_id,day,requests,failures) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3,$4)
          ON CONFLICT (workspace_id,proxy_id,day) DO UPDATE SET requests=control.proxy_daily.requests+EXCLUDED.requests, failures=control.proxy_daily.failures+EXCLUDED.failures`, [principal.workspace_id, o.proxy_id, requests, failures]);
      }
      await client.query(`DELETE FROM control.proxy_daily WHERE workspace_id=$1 AND day < (clock_timestamp() AT TIME ZONE 'UTC')::date - 8`, [principal.workspace_id]);
      // Assignment enforces the cap; the limit here only keeps a sync response within the contract.
      const lease = (await client.query(`UPDATE control.proxies SET lease_expires_at=clock_timestamp()+($3*interval '1 second')
        WHERE (workspace_id, proxy_id) IN (SELECT workspace_id, proxy_id FROM control.proxies WHERE workspace_id=$1 AND server_id=$2 AND enabled ORDER BY created_at, proxy_id LIMIT $4)
        RETURNING proxy_id, generation, protocol, host, port, username, credential, kind, max_concurrency, tls_insecure, lease_expires_at, exit_country`, [principal.workspace_id, server, LEASE_SECONDS, MAX_PROXIES_PER_SERVER])).rows;
      const expires = lease[0]?.lease_expires_at ?? (await client.query(`SELECT clock_timestamp()+($1*interval '1 second') AS t`, [LEASE_SECONDS])).rows[0]!.t;
      const assignments: ProxyAssignment[] = lease.map(r => ({ proxy_id: r.proxy_id, generation: Number(r.generation), protocol: r.protocol, host: r.host, port: r.port, username: r.username,
        password: r.credential === null ? null : this.sealer().open(r.credential, context(principal.workspace_id, r.proxy_id)), kind: r.kind, max_concurrency: r.max_concurrency, tls_insecure: r.tls_insecure === true, egress_country: r.exit_country ?? null }));
      return { server_id: server, lease_expires_at: iso(expires)!, assignments };
    });
  }

  // ---- Subscription sources -------------------------------------------------
  async listSources(principal: Principal): Promise<ProxySourceView[]> {
    requireRole(principal, 'reader', 'operator');
    const rows = (await this.pool.query(`SELECT s.*, count(p.proxy_id) FILTER (WHERE p.retired_at IS NULL)::int AS active_proxies, count(p.proxy_id) FILTER (WHERE p.retired_at IS NOT NULL)::int AS retired_proxies
      FROM control.proxy_sources s LEFT JOIN control.proxies p ON p.workspace_id=s.workspace_id AND p.source_id=s.source_id WHERE s.workspace_id=$1 GROUP BY s.workspace_id, s.source_id ORDER BY s.name`, [principal.workspace_id])).rows;
    return rows.map(sourceView);
  }
  async createSource(principal: Principal, raw: unknown): Promise<ProxySourceView> {
    requireRole(principal, 'operator');
    const input = ProxySourceCreateSchema.parse(raw);
    const count = (await this.pool.query('SELECT count(*)::int AS n FROM control.proxy_sources WHERE workspace_id=$1', [principal.workspace_id])).rows[0]!.n as number;
    if (count >= 50) throw new StoreError('BUDGET_EXHAUSTED', 'At most 50 proxy sources per workspace');
    try {
      const row = (await this.pool.query(`INSERT INTO control.proxy_sources(workspace_id,source_id,name,url,protocol,provider,group_name,country_code,kind,max_concurrency,interval_minutes,retire_after_misses,server_ids,allow_insecure_tls)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *, 0 AS active_proxies, 0 AS retired_proxies`, [principal.workspace_id, randomUUID(), input.name, input.url, input.protocol, input.provider,
        input.group, input.country_code, input.kind, input.max_concurrency, input.interval_minutes, input.retire_after_misses, input.server_ids, input.allow_insecure_tls])).rows[0]!;
      return sourceView(row);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new StoreError('CONFLICT', 'This source URL is already registered');
      throw error;
    }
  }
  async updateSource(principal: Principal, sourceId: string, raw: unknown): Promise<ProxySourceView> {
    requireRole(principal, 'operator');
    const change = ProxySourceUpdateSchema.parse(raw);
    const row = (await this.pool.query(`UPDATE control.proxy_sources SET enabled=coalesce($4,enabled), interval_minutes=coalesce($5,interval_minutes), server_ids=coalesce($6,server_ids),
        next_fetch_at=CASE WHEN $7 THEN clock_timestamp() ELSE next_fetch_at END, version=version+1, updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND source_id=$2 AND version=$3 RETURNING *`, [principal.workspace_id, sourceId, change.expected_version, change.enabled ?? null,
        change.interval_minutes ?? null, change.server_ids ?? null, change.refresh_now === true])).rows[0];
    if (!row) {
      const exists = (await this.pool.query('SELECT 1 FROM control.proxy_sources WHERE workspace_id=$1 AND source_id=$2', [principal.workspace_id, sourceId])).rowCount;
      throw exists ? new StoreError('CONFLICT', 'Source changed; refresh before editing') : new StoreError('NOT_FOUND', 'Source not found', 404);
    }
    return (await this.listSources(principal)).find(v => v.source_id === sourceId)!;
  }
  /** Background refresher: lease one due source so parallel refreshers never fetch the same one. */
  async claimDueSource(leaseSeconds = 120, workspaceId?: string): Promise<SourceClaim | null> {
    const row = (await this.pool.query(`UPDATE control.proxy_sources SET lease_until=clock_timestamp()+($1*interval '1 second')
      WHERE (workspace_id, source_id) = (SELECT workspace_id, source_id FROM control.proxy_sources WHERE enabled AND next_fetch_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
        AND ($2::text IS NULL OR workspace_id=$2) ORDER BY next_fetch_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING workspace_id, source_id, url, etag, lease_until`, [leaseSeconds, workspaceId ?? null])).rows[0];
    return row ? { workspace_id: row.workspace_id, source_id: row.source_id, url: row.url, etag: row.etag, lease_until: iso(row.lease_until)! } : null;
  }
  /** Apply one fetch result. Adds new endpoints, retires ones missing N times in a row, restores reappearing ones and spreads unassigned ones over the source's servers. */
  async applySourceFetch(claim: SourceClaim, result: SourceFetchResult): Promise<{ added: number; retired: number; restored: number; assigned: number; count: number }> {
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proxies:${claim.workspace_id}`]);
      const source = (await client.query(`SELECT * FROM control.proxy_sources WHERE workspace_id=$1 AND source_id=$2 AND date_trunc('milliseconds', lease_until)=$3::timestamptz FOR UPDATE`, [claim.workspace_id, claim.source_id, claim.lease_until])).rows[0];
      // The lease is the claim's identity (compared at the millisecond precision it was handed out with).
      if (!source) return { added: 0, retired: 0, restored: 0, assigned: 0, count: 0 }; // lease lost or source removed
      const finish = (status: string, fields: { error?: string; count?: number; added?: number; retired?: number; etag?: string | null; retryMinutes?: number }) => client.query(
        `UPDATE control.proxy_sources SET last_fetched_at=clock_timestamp(), last_status=$3, last_error=$4, last_count=coalesce($5,last_count), last_added=$6, last_retired=$7, etag=coalesce($8,etag),
          next_fetch_at=clock_timestamp()+($9*interval '1 minute'), lease_until=NULL WHERE workspace_id=$1 AND source_id=$2`,
        [claim.workspace_id, claim.source_id, status, fields.error ?? null, fields.count ?? null, fields.added ?? 0, fields.retired ?? 0, fields.etag ?? null, fields.retryMinutes ?? source.interval_minutes]);
      if (result.status === 'error') { await finish('error', { error: result.error.slice(0, 200), retryMinutes: Math.min(10, source.interval_minutes) }); return { added: 0, retired: 0, restored: 0, assigned: 0, count: 0 }; }
      if (result.status === 'not_modified') { await finish('not_modified', {}); return { added: 0, retired: 0, restored: 0, assigned: 0, count: source.last_count ?? 0 }; }
      const parsed = parseProxyList(result.body, source.protocol);
      // Endpoints that need their certificate check skipped are used only if the source opted in.
      const listed = parsed.entries.filter(e => !e.tls_insecure || source.allow_insecure_tls);
      const skipped = parsed.skipped + parsed.entries.length - listed.length;
      if (!listed.length) { await finish('error', { error: `No usable endpoints (${parsed.invalid} invalid, ${skipped} skipped)`, retryMinutes: Math.min(10, source.interval_minutes) }); return { added: 0, retired: 0, restored: 0, assigned: 0, count: 0 }; }
      const all = (await client.query(`SELECT proxy_id, protocol, lower(host) AS host, port, coalesce(username,'') AS username, source_id, enabled, retired_at, source_misses,
          retire_reason='unhealthy' AND retired_at > clock_timestamp()-($2*interval '1 hour') AS quarantined FROM control.proxies WHERE workspace_id=$1`, [claim.workspace_id, UNHEALTHY_QUARANTINE_HOURS])).rows;
      const key = (e: { protocol: string; host: string; port: number; username: string | null }) => `${e.protocol}|${e.host.toLowerCase()}|${e.port}|${e.username ?? ''}`;
      const byKey = new Map(all.map(r => [key(r), r]));
      const seen = new Set<string>();
      let added = 0, restored = 0, retired = 0, total = all.length;
      for (const entry of listed) {
        const k = key(entry), existing = byKey.get(k);
        seen.add(k);
        if (existing) {
          if (existing.source_id !== claim.source_id) continue; // manual or another source owns it
          if (existing.retired_at && !existing.quarantined) { restored++; await client.query('UPDATE control.proxies SET enabled=true, retired_at=NULL, retire_reason=NULL, source_misses=0, version=version+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND proxy_id=$2', [claim.workspace_id, existing.proxy_id]); }
          else if (existing.source_misses) await client.query('UPDATE control.proxies SET source_misses=0 WHERE workspace_id=$1 AND proxy_id=$2', [claim.workspace_id, existing.proxy_id]);
          continue;
        }
        if (total >= INVENTORY_LIMIT) break;
        const proxyId = randomUUID();
        await client.query(`INSERT INTO control.proxies(workspace_id,proxy_id,protocol,host,port,username,credential,provider,group_name,country_code,kind,max_concurrency,source_id,tls_insecure)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [claim.workspace_id, proxyId, entry.protocol, entry.host, entry.port, entry.username,
          entry.password === null ? null : this.sealer().seal(entry.password, context(claim.workspace_id, proxyId)), source.provider, source.group_name, source.country_code, source.kind, source.max_concurrency, claim.source_id, entry.tls_insecure]);
        added++; total++;
      }
      for (const row of all.filter(r => r.source_id === claim.source_id && !seen.has(key(r)))) {
        const misses = row.source_misses + 1;
        const retire = misses >= source.retire_after_misses && !row.retired_at && row.enabled;
        if (retire) retired++;
        await client.query(`UPDATE control.proxies SET source_misses=$3${retire ? ", enabled=false, retired_at=clock_timestamp(), retire_reason='source_missing', server_id=NULL, generation=generation+1, lease_expires_at=NULL, version=version+1, updated_at=clock_timestamp()" : ''}
          WHERE workspace_id=$1 AND proxy_id=$2`, [claim.workspace_id, row.proxy_id, misses]);
      }
      // Spread this source's unassigned, enabled endpoints over its servers, least-loaded first, up to the per-server cap.
      let assigned = 0;
      if (source.server_ids.length) {
        const load = new Map<string, number>((source.server_ids as string[]).map(s => [s, 0]));
        for (const r of (await client.query('SELECT server_id, count(*)::int AS n FROM control.proxies WHERE workspace_id=$1 AND server_id=ANY($2::text[]) AND enabled GROUP BY server_id', [claim.workspace_id, source.server_ids])).rows) load.set(r.server_id, r.n);
        const pending = (await client.query('SELECT proxy_id FROM control.proxies WHERE workspace_id=$1 AND source_id=$2 AND enabled AND server_id IS NULL ORDER BY created_at, proxy_id', [claim.workspace_id, claim.source_id])).rows;
        for (const r of pending) {
          const [server, n] = [...load].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]!;
          if (n >= MAX_PROXIES_PER_SERVER) break; // every server is full; the rest wait for retired slots
          await client.query('UPDATE control.proxies SET server_id=$3, generation=generation+1, lease_expires_at=NULL, version=version+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND proxy_id=$2', [claim.workspace_id, r.proxy_id, server]);
          load.set(server, load.get(server)! + 1); assigned++;
        }
      }
      await finish('ok', { count: listed.length, added, retired, etag: result.etag ?? null });
      return { added, retired, restored, assigned, count: listed.length };
    });
  }
}

export interface SourceClaim { workspace_id: string; source_id: string; url: string; etag: string | null; lease_until: string; }
export type SourceFetchResult = { status: 'ok'; body: string; etag?: string | null } | { status: 'not_modified' } | { status: 'error'; error: string };
function sourceView(r: QueryResultRow): ProxySourceView {
  return { source_id: r.source_id, name: r.name, url: r.url, protocol: r.protocol, provider: r.provider, group: r.group_name, country_code: r.country_code, kind: r.kind,
    max_concurrency: r.max_concurrency, interval_minutes: r.interval_minutes, retire_after_misses: r.retire_after_misses, server_ids: r.server_ids, allow_insecure_tls: r.allow_insecure_tls === true, enabled: r.enabled, version: r.version,
    next_fetch_at: iso(r.next_fetch_at)!, last_fetched_at: iso(r.last_fetched_at ?? null), last_status: r.last_status ?? null, last_error: r.last_error ?? null,
    last_count: r.last_count ?? null, last_added: r.last_added ?? null, last_retired: r.last_retired ?? null, active_proxies: Number(r.active_proxies ?? 0), retired_proxies: Number(r.retired_proxies ?? 0) };
}
type ListedProxy = { protocol: 'http' | 'https' | 'socks5'; host: string; port: number; username: string | null; password: string | null; tls_insecure: boolean };
const HOST_PATTERN = /^[A-Za-z0-9.:\[\]-]{1,253}$/;
/**
 * A subscription body: a Clash/Mihomo config (its `proxies:` list) or plain lines of host:port or
 * scheme://[user:pass@]host:port (blanks and # comments ignored). Duplicates collapse; `skipped`
 * counts Clash entries of other protocols or with credentials (public lists carry shared
 * accounts, which are not imported).
 */
export function parseProxyList(body: string, protocol: 'http' | 'https' | 'socks5'): { entries: ListedProxy[]; invalid: number; skipped: number } {
  const entries = new Map<string, ListedProxy>();
  const add = (entry: ListedProxy) => entries.set(`${entry.protocol}|${entry.host.toLowerCase()}|${entry.port}|${entry.username ?? ''}`, entry);
  let invalid = 0, skipped = 0;
  const clash = clashProxies(body);
  if (clash) {
    for (const item of clash) {
      const type = item.type?.toLowerCase(), port = Number(item.port), host = item.server ?? '';
      if (type !== 'http' && type !== 'socks5') { skipped++; continue; }
      if (item.username || item.password) { skipped++; continue; }
      if (!HOST_PATTERN.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) { invalid++; continue; }
      const tls = type === 'http' && isTrue(item.tls);
      add({ protocol: tls ? 'https' : type, host, port, username: null, password: null, tls_insecure: tls && isTrue(item['skip-cert-verify']) });
    }
    return { entries: [...entries.values()], invalid, skipped };
  }
  for (const raw of body.split(/\r?\n/).slice(0, 20_000)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const url = new URL(line.includes('://') ? line : `${protocol}://${line}`);
      const scheme = url.protocol.slice(0, -1), port = Number(url.port);
      if (!['http', 'https', 'socks5'].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535 || !HOST_PATTERN.test(url.hostname) || url.pathname.length > 1) { invalid++; continue; }
      add({ protocol: scheme as 'http', host: url.hostname, port, username: url.username ? decodeURIComponent(url.username) : null, password: url.password ? decodeURIComponent(url.password) : null, tls_insecure: false });
    } catch { invalid++; }
  }
  return { entries: [...entries.values()], invalid, skipped };
}
const isTrue = (value: string | undefined) => value !== undefined && /^(true|yes|on)$/i.test(value);
/**
 * The scalar fields of each item in a Clash config's top-level `proxies:` list, block or flow
 * style; null when the body has no such list. Nested maps (ws-opts, plugin-opts, …) are not
 * descended into; only the item's own keys are read. Enough for proxy lists, not a YAML parser.
 */
function clashProxies(body: string): Record<string, string>[] | null {
  const lines = body.split(/\r?\n/).slice(0, 200_000);
  const start = lines.findIndex(l => /^proxies:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const items: Record<string, string>[] = [];
  let item: Record<string, string> | null = null, dashIndent = -1, keyIndent = -1;
  for (const raw of lines.slice(start + 1)) {
    const text = raw.trimEnd();
    if (!text.trim() || text.trim().startsWith('#')) continue;
    const indent = text.length - text.trimStart().length;
    if (indent === 0 && !text.startsWith('-')) break; // next top-level key
    const dash = /^(\s*)-\s+(.*)$/.exec(text) ?? /^(\s*)-$/.exec(text);
    if (dash && (dashIndent < 0 || dash[1]!.length === dashIndent)) {
      dashIndent = dash[1]!.length; item = {}; items.push(item);
      const rest = dash[2] ?? '';
      keyIndent = text.length - rest.length;
      if (rest.startsWith('{')) Object.assign(item, flowMap(rest));
      else if (rest) assignScalar(item, rest);
      continue;
    }
    if (item && keyIndent < 0) keyIndent = indent;
    if (item && indent === keyIndent) assignScalar(item, text.trim());
  }
  return items;
}
function assignScalar(target: Record<string, string>, text: string) {
  const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(text);
  if (!m || m[2] === undefined || /^(null|Null|NULL|~)(\s+#.*)?$/.test(m[2].trim())) return; // YAML null: no value
  target[m[1]!] = unquote(m[2]);
}
function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("'")) { const end = v.indexOf(v[0]!, 1); return end > 0 ? v.slice(1, end) : v.slice(1); }
  return v.replace(/\s+#.*$/, '').trim();
}
/** `{a: 1, b: "x, y", c: {d: 2}}` → top-level scalars only. */
function flowMap(text: string): Record<string, string> {
  const inner = text.slice(1, text.lastIndexOf('}') > 0 ? text.lastIndexOf('}') : undefined), out: Record<string, string> = {};
  let depth = 0, quote = '', part = '';
  const flush = () => { if (depth === 0) assignScalar(out, part.trim()); part = ''; };
  for (const ch of inner) {
    if (quote) { if (ch === quote) quote = ''; part += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; part += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { flush(); continue; }
    part += ch;
  }
  flush();
  return out;
}
/** A server may hold at most MAX_PROXIES_PER_SERVER enabled endpoints (checked after the change, inside its transaction). */
async function assertServerCapacity(client: PoolClient, workspaceId: string, proxyId: string): Promise<void> {
  const row = (await client.query(`SELECT count(*)::int AS n FROM control.proxies WHERE workspace_id=$1 AND enabled
      AND server_id=(SELECT server_id FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2)`, [workspaceId, proxyId])).rows[0]!;
  if (row.n > MAX_PROXIES_PER_SERVER) throw new StoreError('BUDGET_EXHAUSTED', `A server can hold at most ${MAX_PROXIES_PER_SERVER} enabled proxies`);
}
