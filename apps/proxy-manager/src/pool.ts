import { randomUUID } from 'node:crypto';
import type { ProxyAssignment } from '@crawlsystem/contracts';
import { proxyUrlOf } from '@crawlsystem/execution-client/proxy-connect';

// Node-local proxy selection (24.8 §10.2): one pool per server, shared by every Worker on
// it, so per-proxy concurrency and cooldown are enforced once rather than per Pod.
export type Outcome = 'success' | 'failure' | 'blocked' | 'timeout';
export interface Lease { lease_id: string; proxy_id: string; generation: number; proxy_url: string; expires_at: number; egress_country?: string | null; }
interface Health {
  inflight: number; consecutiveFailures: number; cooldownUntil: number; cooldowns: number;
  lastSuccess: number | null; lastFailure: number | null; lastError: string | null;
  requests: number; failures: number; latencyMs: number | null; probedAt: number | null;
  // Trial: a proxy is leased only after TRIAL_PASSES content probes in a row pass; a block sends it back to trial.
  qualified: boolean; trialPasses: number;
}
const COOLDOWN_BASE_MS = 60_000, COOLDOWN_MAX_MS = 30 * 60_000, BLOCKED_COOLDOWN_MS = 10 * 60_000;
const FAILURES_BEFORE_COOLDOWN = 3, COOLDOWNS_BEFORE_FAILED = 3, TRIAL_PASSES = 2;

// The fragment never leaves this host; connectViaProxy reads it (and ignores it if credentials are present).
export const proxyUrl = (a: ProxyAssignment): string => proxyUrlOf(a);

export class ProxyPool {
  private assignments = new Map<string, ProxyAssignment>();
  private health = new Map<string, Health>();
  private leases = new Map<string, Lease>();
  private leaseUntil = 0;
  constructor(private now: () => number = Date.now, private random: () => number = Math.random) {}

  /** Replace the assignment set from a sync. Health survives for proxies kept at the same generation. */
  apply(assignments: ProxyAssignment[], leaseExpiresAt: number): void {
    const next = new Map(assignments.map(a => [a.proxy_id, a]));
    for (const [id, old] of this.assignments) {
      const kept = next.get(id);
      if (!kept || kept.generation !== old.generation) this.health.delete(id);
    }
    this.assignments = next; this.leaseUntil = leaseExpiresAt;
  }
  /** Without a valid central lease nothing may be handed out (split-brain guard). */
  get authorized(): boolean { return this.now() < this.leaseUntil; }
  private state(id: string): Health {
    let h = this.health.get(id);
    if (!h) { h = { inflight: 0, consecutiveFailures: 0, cooldownUntil: 0, cooldowns: 0, lastSuccess: null, lastFailure: null, lastError: null, requests: 0, failures: 0, latencyMs: null, probedAt: null, qualified: false, trialPasses: 0 }; this.health.set(id, h); }
    return h;
  }
  acquire(ttlMs = 120_000, requiredCountry?: string): Lease | { wait_ms: number; reason: 'unauthorized' | 'no_proxies' | 'in_trial' | 'all_busy_or_cooling' } {
    this.expire();
    const now = this.now();
    if (!this.authorized) return { wait_ms: 30_000, reason: 'unauthorized' };
    if (!this.assignments.size) return { wait_ms: 60_000, reason: 'no_proxies' };
    const ready = [...this.assignments.values()].filter(a => { const h = this.state(a.proxy_id); return (!requiredCountry || a.egress_country === requiredCountry) && h.qualified && h.cooldownUntil <= now && h.inflight < a.max_concurrency; });
    if (!ready.length) {
      if (![...this.assignments.keys()].some(id => this.state(id).qualified)) return { wait_ms: 30_000, reason: 'in_trial' };
      const soonest = Math.min(...[...this.assignments.keys()].map(id => this.state(id).cooldownUntil).filter(t => t > now), now + 5_000);
      return { wait_ms: Math.max(1_000, soonest - now), reason: 'all_busy_or_cooling' };
    }
    // Prefer proxies with fewer failures and fewer in-flight leases; randomise among equals.
    const score = (a: ProxyAssignment) => { const h = this.state(a.proxy_id); return h.consecutiveFailures * 10 + h.inflight / a.max_concurrency + this.random() * 0.5; };
    const chosen = ready.sort((x, y) => score(x) - score(y))[0]!;
    this.state(chosen.proxy_id).inflight++;
    const lease: Lease = { lease_id: randomUUID(), proxy_id: chosen.proxy_id, generation: chosen.generation, proxy_url: proxyUrl(chosen), expires_at: Math.min(now + ttlMs, this.leaseUntil), egress_country: chosen.egress_country ?? null };
    this.leases.set(lease.lease_id, lease);
    return lease;
  }
  release(leaseId: string, outcome: Outcome, latencyMs?: number, errorClass?: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    this.leases.delete(leaseId);
    const h = this.health.get(lease.proxy_id);
    if (!h || this.assignments.get(lease.proxy_id)?.generation !== lease.generation) return true; // reassigned meanwhile
    h.inflight = Math.max(0, h.inflight - 1);
    this.record(h, outcome, latencyMs, errorClass);
    return true;
  }
  /** Active health check result (not a Worker request, so it does not count toward requests). `blocked`: YouTube refused this egress. */
  probed(proxyId: string, ok: boolean, latencyMs: number | null, errorClass?: string, blocked = false): void {
    const h = this.health.get(proxyId) ?? (this.assignments.has(proxyId) ? this.state(proxyId) : undefined);
    if (!h) return;
    h.probedAt = this.now();
    if (ok) {
      h.consecutiveFailures = 0; h.cooldowns = 0; h.lastSuccess = this.now(); h.latencyMs = latencyMs; h.cooldownUntil = 0;
      if (++h.trialPasses >= TRIAL_PASSES) h.qualified = true;
      return;
    }
    h.trialPasses = 0;
    if (blocked) this.block(h, errorClass ?? 'blocked');
    else this.fail(h, errorClass ?? 'probe_failed');
  }
  private record(h: Health, outcome: Outcome, latencyMs?: number, errorClass?: string) {
    h.requests++;
    if (outcome === 'success') {
      h.consecutiveFailures = 0; h.cooldowns = 0; h.lastSuccess = this.now();
      if (latencyMs !== undefined) h.latencyMs = h.latencyMs === null ? latencyMs : Math.round(h.latencyMs * 0.7 + latencyMs * 0.3);
      return;
    }
    h.failures++;
    if (outcome === 'blocked') return this.block(h, errorClass ?? 'blocked');
    this.fail(h, errorClass ?? outcome);
  }
  /** YouTube refused this egress: cool down, and require a fresh trial before it is leased again. */
  private block(h: Health, error: string) {
    h.lastFailure = this.now(); h.lastError = error.slice(0, 120); h.cooldownUntil = this.now() + BLOCKED_COOLDOWN_MS; h.cooldowns++;
    h.qualified = false; h.trialPasses = 0;
  }
  private fail(h: Health, error: string) {
    h.consecutiveFailures++; h.lastFailure = this.now(); h.lastError = error.slice(0, 120);
    if (h.consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
      h.cooldownUntil = this.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** h.cooldowns);
      h.cooldowns++; h.consecutiveFailures = 0;
    }
  }
  /** Leases a Worker never returned count as timeouts and free their slot. */
  expire(): void {
    const now = this.now();
    for (const lease of [...this.leases.values()]) if (lease.expires_at <= now) this.release(lease.lease_id, 'timeout', undefined, 'lease_expired');
  }
  /**
   * Proxies due for an active check: idle and never checked, or not checked for `everyMs` (`trialEveryMs` while in trial).
   * Proxies one pass away from qualifying go first, so usable ones join quickly even in a large new pool; then oldest check first.
   */
  probeCandidates(everyMs: number, limit: number, trialEveryMs = everyMs): ProxyAssignment[] {
    const now = this.now();
    const rank = (a: ProxyAssignment) => { const h = this.state(a.proxy_id); return !h.qualified && h.trialPasses > 0 ? 0 : 1; };
    return [...this.assignments.values()].filter(a => { const h = this.state(a.proxy_id); return h.inflight === 0 && h.cooldownUntil <= now && (h.probedAt === null || now - h.probedAt >= (h.qualified ? everyMs : trialEveryMs)); })
      .sort((x, y) => rank(x) - rank(y) || (this.state(x.proxy_id).probedAt ?? 0) - (this.state(y.proxy_id).probedAt ?? 0)).slice(0, limit);
  }
  /** Observations for the central sync; unobserved proxies are omitted (Control shows them as unknown). */
  observations() {
    const now = this.now(), iso = (t: number | null) => t === null ? null : new Date(t).toISOString();
    return [...this.assignments.values()].flatMap(a => {
      const h = this.health.get(a.proxy_id);
      if (!h || (h.lastSuccess === null && h.lastFailure === null)) return [];
      // `failed` (three cooldowns without a success in between) is what Control retires on.
      const state = h.cooldownUntil > now ? (h.cooldowns >= COOLDOWNS_BEFORE_FAILED ? 'failed' as const : 'cooldown' as const)
        : !h.qualified ? 'trial' as const : h.consecutiveFailures > 0 ? 'degraded' as const : 'healthy' as const;
      return [{ proxy_id: a.proxy_id, generation: a.generation, state, cooldown_until: h.cooldownUntil > now ? iso(h.cooldownUntil) : null, last_success_at: iso(h.lastSuccess),
        last_failure_at: iso(h.lastFailure), last_error: h.lastError, requests_total: h.requests, failures_total: h.failures, latency_ms: h.latencyMs }];
    });
  }
  stats() {
    const qualified = [...this.assignments.keys()].filter(id => this.health.get(id)?.qualified).length;
    return { assigned: this.assignments.size, qualified, leases: this.leases.size, authorized: this.authorized };
  }
}
