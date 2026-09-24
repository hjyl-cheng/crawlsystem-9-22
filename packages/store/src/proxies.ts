import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ProxyImportSchema, ProxySyncRequestSchema, ProxyUpdateSchema, type Principal, type ProxyAssignment, type ProxyOverview, type ProxyState, type ProxySyncResponse, type ProxyView } from '@crawlsystem/contracts';
import { StoreError, requireRole } from './index.ts';
import type { CredentialBox } from './credentials.ts';

const LEASE_SECONDS = 300;           // a server must re-sync within this window or stop using its proxies
const OBSERVATION_FRESH_SECONDS = 180; // older reports show as unknown, never as healthy
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
      const count = (await client.query('SELECT count(*)::int AS n FROM m1.proxies WHERE workspace_id=$1', [principal.workspace_id])).rows[0]!.n as number;
      let created = 0, updated = 0;
      for (const entry of entries) {
        const existing = (await client.query(`SELECT proxy_id FROM m1.proxies WHERE workspace_id=$1 AND protocol=$2 AND lower(host)=lower($3) AND port=$4 AND coalesce(username,'')=$5`,
          [principal.workspace_id, entry.protocol, entry.host, entry.port, entry.username ?? ''])).rows[0];
        const proxyId = existing?.proxy_id as string | undefined ?? randomUUID();
        const credential = entry.password === null ? null : this.box!.seal(entry.password, context(principal.workspace_id, proxyId));
        if (existing) {
          await client.query(`UPDATE m1.proxies SET provider=$3,group_name=$4,country_code=$5,kind=$6,max_concurrency=$7,credential=coalesce($8,credential),version=version+1,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND proxy_id=$2`, [principal.workspace_id, proxyId, entry.provider, entry.group, entry.country_code, entry.kind, entry.max_concurrency, credential]);
          updated++;
        } else {
          if (count + created >= 2000) throw new StoreError('BUDGET_EXHAUSTED', 'Proxy inventory is limited to 2000 endpoints per workspace');
          await client.query(`INSERT INTO m1.proxies(workspace_id,proxy_id,protocol,host,port,username,credential,provider,group_name,country_code,kind,max_concurrency)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [principal.workspace_id, proxyId, entry.protocol, entry.host, entry.port, entry.username, credential, entry.provider, entry.group, entry.country_code, entry.kind, entry.max_concurrency]);
          created++;
        }
      }
      return { created, updated };
    });
  }
  async overview(principal: Principal): Promise<ProxyOverview> {
    requireRole(principal, 'reader', 'operator');
    const rows = (await this.pool.query(`SELECT p.*, o.server_id AS observed_server, o.generation AS observed_generation, o.state AS observed_state, o.cooldown_until, o.last_success_at, o.last_failure_at,
        o.last_error, o.latency_ms, o.observed_at, o.reported_at > clock_timestamp()-($2*interval '1 second') AS fresh,
        coalesce(d.requests,0)::bigint AS requests_today, coalesce(d.failures,0)::bigint AS failures_today, clock_timestamp() AS now
      FROM m1.proxies p LEFT JOIN m1.proxy_observations o USING (workspace_id, proxy_id)
      LEFT JOIN m1.proxy_daily d ON d.workspace_id=p.workspace_id AND d.proxy_id=p.proxy_id AND d.day=(clock_timestamp() AT TIME ZONE 'UTC')::date
      WHERE p.workspace_id=$1 ORDER BY p.group_name, p.host, p.port LIMIT 2000`, [principal.workspace_id, OBSERVATION_FRESH_SECONDS])).rows;
    const items = rows.map(r => this.view(r));
    const tally = <K extends string>(keys: K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
    const by_state = tally(['healthy', 'degraded', 'cooldown', 'failed', 'disabled', 'unassigned', 'unknown'] as ProxyState[]);
    const providers = new Map<string, { name: string; count: number; requests_today: number; failures_today: number }>(), groups = new Map<string, number>();
    for (const item of items) {
      by_state[item.state]++;
      const p = providers.get(item.provider) ?? { name: item.provider, count: 0, requests_today: 0, failures_today: 0 };
      p.count++; p.requests_today += item.requests_today; p.failures_today += item.failures_today; providers.set(item.provider, p);
      groups.set(item.group, (groups.get(item.group) ?? 0) + 1);
    }
    const days = (await this.pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, sum(requests)::bigint AS requests, sum(failures)::bigint AS failures FROM m1.proxy_daily
      WHERE workspace_id=$1 AND day > (clock_timestamp() AT TIME ZONE 'UTC')::date - 7 GROUP BY day ORDER BY day`, [principal.workspace_id])).rows;
    return { observed_at: iso(rows[0]?.now ?? new Date())!, items, by_state, providers: [...providers.values()].sort((a, b) => b.count - a.count),
      groups: [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      requests_today: items.reduce((n, i) => n + i.requests_today, 0), failures_today: items.reduce((n, i) => n + i.failures_today, 0),
      availability_7d: days.map(d => ({ day: d.day, requests: Number(d.requests), failures: Number(d.failures) })) };
  }
  private view(r: QueryResultRow): ProxyView {
    // Only a fresh report for the current assignment generation describes the proxy.
    const current = r.observed_state && r.fresh && r.observed_server === r.server_id && Number(r.observed_generation) === Number(r.generation);
    const state: ProxyState = !r.enabled ? 'disabled' : !r.server_id ? 'unassigned' : current ? r.observed_state : 'unknown';
    return { proxy_id: r.proxy_id, protocol: r.protocol, host: r.host, port: r.port, username: r.username, has_password: r.credential !== null,
      provider: r.provider, group: r.group_name, country_code: r.country_code, kind: r.kind, max_concurrency: r.max_concurrency, enabled: r.enabled, version: r.version,
      server_id: r.server_id, state, cooldown_until: current ? iso(r.cooldown_until) : null, last_success_at: iso(r.last_success_at ?? null), last_failure_at: iso(r.last_failure_at ?? null),
      last_error: r.last_error ?? null, requests_today: Number(r.requests_today), failures_today: Number(r.failures_today), latency_ms: current ? r.latency_ms ?? null : null,
      observed_at: iso(r.observed_at ?? null), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! };
  }
  /** Enable/disable and (re)assign with a version check. A new server gets a new generation; the old lease is dropped. */
  async update(principal: Principal, proxyId: string, raw: unknown): Promise<ProxyView> {
    requireRole(principal, 'operator');
    const change = ProxyUpdateSchema.parse(raw);
    return this.tx(async client => {
      const row = (await client.query('SELECT * FROM m1.proxies WHERE workspace_id=$1 AND proxy_id=$2 FOR UPDATE', [principal.workspace_id, proxyId])).rows[0];
      if (!row) throw new StoreError('NOT_FOUND', 'Proxy not found', 404);
      if (row.version !== change.expected_version) throw new StoreError('CONFLICT', 'Proxy changed; refresh before editing');
      const reassign = change.server_id !== undefined && change.server_id !== row.server_id;
      await client.query(`UPDATE m1.proxies SET enabled=coalesce($3,enabled), server_id=CASE WHEN $4 THEN $5 ELSE server_id END,
          generation=generation+CASE WHEN $4 THEN 1 ELSE 0 END, lease_expires_at=CASE WHEN $4 THEN NULL ELSE lease_expires_at END,
          version=version+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND proxy_id=$2`,
        [principal.workspace_id, proxyId, change.enabled ?? null, reassign, change.server_id ?? null]);
      const updated = (await client.query(`SELECT p.*, NULL AS observed_state, 0::bigint AS requests_today, 0::bigint AS failures_today FROM m1.proxies p WHERE workspace_id=$1 AND proxy_id=$2`, [principal.workspace_id, proxyId])).rows[0]!;
      return this.view(updated);
    });
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
        const own = (await client.query('SELECT 1 FROM m1.proxies WHERE workspace_id=$1 AND proxy_id=$2 AND server_id=$3 AND generation=$4', [principal.workspace_id, o.proxy_id, server, o.generation])).rowCount;
        if (!own) continue;
        const previous = (await client.query('SELECT * FROM m1.proxy_observations WHERE workspace_id=$1 AND proxy_id=$2 FOR UPDATE', [principal.workspace_id, o.proxy_id])).rows[0];
        const sameStream = previous && previous.node_boot_id === report.node_boot_id && previous.server_id === server && Number(previous.generation) === o.generation;
        if (sameStream && Number(previous.report_sequence) >= report.report_sequence) continue; // duplicate or out of order
        // Cumulative counters restart with a new boot or assignment; deltas never go negative.
        const requests = sameStream ? Math.max(0, o.requests_total - Number(previous.requests_total)) : o.requests_total;
        const failures = sameStream ? Math.max(0, o.failures_total - Number(previous.failures_total)) : o.failures_total;
        await client.query(`INSERT INTO m1.proxy_observations(workspace_id,proxy_id,server_id,generation,state,cooldown_until,last_success_at,last_failure_at,last_error,requests_total,failures_total,latency_ms,node_boot_id,report_sequence,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (workspace_id,proxy_id) DO UPDATE SET server_id=EXCLUDED.server_id,generation=EXCLUDED.generation,state=EXCLUDED.state,cooldown_until=EXCLUDED.cooldown_until,
            last_success_at=EXCLUDED.last_success_at,last_failure_at=EXCLUDED.last_failure_at,last_error=EXCLUDED.last_error,requests_total=EXCLUDED.requests_total,failures_total=EXCLUDED.failures_total,
            latency_ms=EXCLUDED.latency_ms,node_boot_id=EXCLUDED.node_boot_id,report_sequence=EXCLUDED.report_sequence,observed_at=EXCLUDED.observed_at,reported_at=clock_timestamp()`,
          [principal.workspace_id, o.proxy_id, server, o.generation, o.state, o.cooldown_until, o.last_success_at, o.last_failure_at, o.last_error, o.requests_total, o.failures_total, o.latency_ms, report.node_boot_id, report.report_sequence, report.observed_at]);
        if (requests || failures) await client.query(`INSERT INTO m1.proxy_daily(workspace_id,proxy_id,day,requests,failures) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3,$4)
          ON CONFLICT (workspace_id,proxy_id,day) DO UPDATE SET requests=m1.proxy_daily.requests+EXCLUDED.requests, failures=m1.proxy_daily.failures+EXCLUDED.failures`, [principal.workspace_id, o.proxy_id, requests, failures]);
      }
      await client.query(`DELETE FROM m1.proxy_daily WHERE workspace_id=$1 AND day < (clock_timestamp() AT TIME ZONE 'UTC')::date - 8`, [principal.workspace_id]);
      const lease = (await client.query(`UPDATE m1.proxies SET lease_expires_at=clock_timestamp()+($3*interval '1 second') WHERE workspace_id=$1 AND server_id=$2 AND enabled
        RETURNING proxy_id, generation, protocol, host, port, username, credential, kind, max_concurrency, lease_expires_at`, [principal.workspace_id, server, LEASE_SECONDS])).rows;
      const expires = lease[0]?.lease_expires_at ?? (await client.query(`SELECT clock_timestamp()+($1*interval '1 second') AS t`, [LEASE_SECONDS])).rows[0]!.t;
      const assignments: ProxyAssignment[] = lease.map(r => ({ proxy_id: r.proxy_id, generation: Number(r.generation), protocol: r.protocol, host: r.host, port: r.port, username: r.username,
        password: r.credential === null ? null : this.sealer().open(r.credential, context(principal.workspace_id, r.proxy_id)), kind: r.kind, max_concurrency: r.max_concurrency }));
      return { server_id: server, lease_expires_at: iso(expires)!, assignments };
    });
  }
}
