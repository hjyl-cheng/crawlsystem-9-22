import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionApiError, type ExecutionApi } from '@crawlsystem/execution-client/http';
import type { QueryRunClaim, QUERY_RUN_FAILURES } from '@crawlsystem/contracts';
import { DataApiError, type DataApi, type RequestGuard } from './youtube/data-api.ts';
import { toCandidateFacts } from './youtube/map.ts';
import { ScrapeError, searchPages, session } from './youtube/scrape.ts';
import { ProxyUnavailable, proxiedFetch, type LeaseClient, type Outcome } from './youtube/transport.ts';

/**
 * Search execution (plan step B2): claim a due query run from Control, read its result pages through a
 * leased proxy, qualify the channels new to the system with the Data API and report the result. Control
 * owns the run: a lost lease, a disabled query or a stale attempt stops the work, and failures are
 * retried by Control on the same run with the same frozen parameters.
 */
type Run = NonNullable<QueryRunClaim['run']>;
type FailReason = typeof QUERY_RUN_FAILURES[number];
export interface QueryRunnerOptions {
  api: ExecutionApi; dataApi: DataApi; proxies: LeaseClient | 'direct'; workerId: string; signal: AbortSignal;
  log: (record: Record<string, unknown>) => void;
}
/** Control no longer lets this attempt hold the run (cancelled, taken over or finished). */
class RunStopped extends Error {}
class QuotaRefused extends Error {}
const PROXY_WAIT_MS = 120_000, HEARTBEAT_MS = 60_000, CLAIM_RETRY_MS = 30_000;
const pause = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(() => undefined);

export async function runQueries(options: QueryRunnerOptions): Promise<void> {
  while (!options.signal.aborted) {
    let claim: QueryRunClaim;
    try { claim = await options.api.claimQueryRun({ signal: options.signal }); }
    catch (error) {
      if (options.signal.aborted) return;
      options.log({ worker_id: options.workerId, phase: 'QUERY_CLAIM', error_code: error instanceof ExecutionApiError ? error.code : 'UNAVAILABLE' });
      await pause(CLAIM_RETRY_MS, options.signal); continue;
    }
    if (claim.run) await runOne(options, claim.run);
    else await pause(claim.retry_after_ms, options.signal);
  }
}

async function runOne(options: QueryRunnerOptions, run: Run): Promise<void> {
  const { api, log } = options, attempt = run.attempt, started = Date.now();
  const lost = new AbortController(), signal = AbortSignal.any([options.signal, lost.signal]);
  const renew = setInterval(() => void api.queryRunHeartbeat(run.run_id, { attempt }, { attempts: 1 }).then(lease => { if (!lease.active) lost.abort(); }).catch(() => undefined), HEARTBEAT_MS);
  const record = { worker_id: options.workerId, phase: 'QUERY_RUN', run_id: run.run_id, attempt };
  try {
    const found = await search(options, run, signal);
    const facts = await qualify(options, run, found.newIds, signal);
    const result = await api.queryRunComplete(run.run_id, { attempt, pages: found.pages, stop_reason: found.stop_reason, channels: facts.channels, missing_channel_ids: facts.missing }, { signal });
    log({ ...record, outcome: 'SUCCEEDED', pages: found.pages, new_channels: result.new_channels, qualified_new: result.qualified_new, binding_state: result.binding.state, cadence: result.binding.cadence, ms: Date.now() - started });
  } catch (error) {
    if (lost.signal.aborted || error instanceof RunStopped || (error instanceof ExecutionApiError && ['STALE_EXECUTION', 'NOT_FOUND'].includes(error.code))) {
      log({ ...record, outcome: 'STOPPED' }); return;
    }
    const reason: FailReason = options.signal.aborted ? 'interrupted' : failReason(error);
    const after = await api.queryRunFail(run.run_id, { attempt, reason, retryable: reason !== 'internal' }).catch(() => undefined);
    log({ ...record, outcome: 'FAILED', reason, run_state: after?.state ?? 'UNREPORTED', ms: Date.now() - started });
  } finally { clearInterval(renew); }
}

/** Result pages in order, while each page brings enough channels new to the system (Control decides). */
async function search(options: QueryRunnerOptions, run: Run, signal: AbortSignal) {
  const { params } = run;
  return withProxy(options, signal, async fetcher => {
    const yt = await session(fetcher, { lang: params.language, location: params.country });
    const newIds: string[] = [];
    let pages = 0;
    for await (const page of searchPages(yt, params.text, params.window)) {
      signal.throwIfAborted();
      pages += 1;
      const result = await options.api.queryRunPage(run.run_id, { attempt: run.attempt, page: pages, items: page.items.slice(0, 200) }, { signal });
      for (const id of result.new_channel_ids) if (!newIds.includes(id)) newIds.push(id);
      if (!page.more) return { pages, newIds, stop_reason: 'list_end' as const };
      if (!result.continue) return { pages, newIds, stop_reason: pages >= params.max_pages ? 'max_pages' as const : 'low_yield' as const };
    }
    return { pages, newIds, stop_reason: 'list_end' as const };
  });
}

/** Data API facts of the new channels, 50 per request, each request under a run permit. */
async function qualify(options: QueryRunnerOptions, run: Run, ids: string[], signal: AbortSignal) {
  const guard: RequestGuard = {
    async permit(endpoint) {
      if (endpoint !== 'channels') throw new Error('Search runs only read channels');
      const request_id = randomUUID(), permit = await options.api.queryRunPermit(run.run_id, { request_id, attempt: run.attempt, endpoint }, { signal });
      if (!permit.granted) throw new QuotaRefused();
      return request_id;
    },
    async failed(request_id, _endpoint, error) {
      if (request_id) await options.api.queryRunPermitFailure(run.run_id, { request_id, attempt: run.attempt, reason: error.kind }, { signal }).catch(() => undefined);
    },
  };
  const wanted = new Set(ids), channels: ReturnType<typeof toCandidateFacts>[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    signal.throwIfAborted();
    for (const api of await options.dataApi.channelFacts(ids.slice(i, i + 50), guard)) {
      if (wanted.delete(api.id)) channels.push(toCandidateFacts(api));
    }
  }
  return { channels, missing: [...wanted] };
}

/** Run the search through one leased proxy of this node, waiting a bounded time when none is free. */
async function withProxy<T>(options: QueryRunnerOptions, signal: AbortSignal, work: (fetcher: typeof fetch) => Promise<T>): Promise<T> {
  const proxies = options.proxies;
  if (proxies === 'direct') return work(fetch);
  const giveUpAt = Date.now() + PROXY_WAIT_MS;
  for (;;) {
    signal.throwIfAborted();
    let lease;
    try { lease = await proxies.acquire(); }
    catch (error) {
      if (!(error instanceof ProxyUnavailable) || Date.now() + error.waitMs > giveUpAt) throw error;
      await delay(Math.min(error.waitMs, 30_000), undefined, { signal });
      continue;
    }
    const transport = proxiedFetch(lease.proxy_url), started = Date.now();
    let outcome: Outcome = 'success', errorClass: string | undefined;
    try { return await work(transport.fetch); }
    catch (error) {
      if (error instanceof ScrapeError && (error.kind === 'blocked' || error.kind === 'network')) { outcome = error.kind === 'blocked' ? 'blocked' : 'failure'; errorClass = `scrape_${error.kind}`; }
      throw error;
    } finally { await transport.close().catch(() => undefined); await proxies.release(lease, outcome, Date.now() - started, errorClass); }
  }
}

function failReason(error: unknown): FailReason {
  if (error instanceof QuotaRefused) return 'quota';
  if (error instanceof DataApiError) return error.kind === 'quota' ? 'quota' : 'data_api';
  if (error instanceof ScrapeError) return error.kind === 'blocked' ? 'blocked' : error.kind === 'network' ? 'network' : 'parse';
  if (error instanceof ProxyUnavailable) return 'proxy_unavailable';
  if (error instanceof ExecutionApiError) return error.retryable ? 'network' : 'internal';
  return 'internal';
}
