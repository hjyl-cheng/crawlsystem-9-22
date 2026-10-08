import { setTimeout as delay } from 'node:timers/promises';
import { DataApiFailureReportSchema, DataApiPermitRequestSchema, DataApiPermitSchema } from '@crawlsystem/contracts';
import { z } from 'zod';
import { ApiRoutes, ApiErrorSchema, MAX_BODY_BYTES, PlanInputSchema, AgentInputSchema, ReceiptSchema, SessionSchema, WorkerSchema,
  ExecutionEventSchema, HeartbeatSchema, SubmissionSchema, WorkloadTokenSchema, TemporalTokenSchema, ProxySyncRequestSchema, ProxySyncResponseSchema, type ProxySyncRequest, type ErrorCode, type ExecutionEvent, type Heartbeat, type Submission, type Receipt } from '@crawlsystem/contracts';

export class ExecutionApiError extends Error {
  constructor(readonly code: ErrorCode, readonly retryable: boolean, readonly correlationId?: string) {
    // Deliberately omit remote messages, response bodies, URLs, and native error causes.
    super(`Execution API: ${code}`); this.name = 'ExecutionApiError';
  }
}
export interface RequestBudget { signal?: AbortSignal; deadline?: number; attempts?: 1 | 2; traceparent?: string; }
export interface ApiOptions { controlUrl: string; ingestUrl: string; token: () => Promise<string>; timeoutMs?: number; fetch?: typeof fetch; }
export function validateApiUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('API URL must be an origin without credentials');
  // Cluster Service names ride the WireGuard-encrypted pod network (flannel wireguard-native)
  // behind NetworkPolicy; anything else outside loopback must use HTTPS.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['127.0.0.1','localhost','[::1]'].includes(url.hostname) || /^[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local$/.test(url.hostname)))) throw new Error('HTTPS is required outside loopback and cluster Services');
  return url.origin;
}
export interface WorkloadTokenOptions { controlUrl: string; identityToken: () => Promise<string>; workerId: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number; }
interface ExchangeOptions<T extends { token: string; expires_in: number }> { controlUrl: string; route: string; schema: z.ZodType<T>; identityToken: () => Promise<string>;
  accept?: (value: T) => void; timeoutMs?: number; fetch?: typeof fetch; now?: () => number; }
// Exchanges the kubelet-rotated ServiceAccount token at Control for a short token and
// renews it at half-life; concurrent callers share one exchange.
function exchangeTokenSource<T extends { token: string; expires_in: number }>(options: ExchangeOptions<T>): () => Promise<string> {
  const control = validateApiUrl(options.controlUrl), fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  let cached: { token: string; renewAt: number; expiresAt: number } | undefined, pending: Promise<string> | undefined;
  const exchange = async () => {
    const identity = (await options.identityToken()).trim();
    if (!identity || /\s/.test(identity)) throw new ExecutionApiError('UNAUTHENTICATED', false);
    let response: Response;
    try { response = await fetcher(new URL(options.route, control), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${identity}` }, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) }); }
    catch { throw new ExecutionApiError('UNAVAILABLE', true); }
    let data: unknown;
    try { data = await response.json(); } catch { throw new ExecutionApiError('INVALID_REQUEST', false); }
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(data);
      throw parsed.success ? new ExecutionApiError(parsed.data.error.code, parsed.data.error.retryable, parsed.data.error.correlation_id) : new ExecutionApiError('INVALID_REQUEST', false);
    }
    const parsed = options.schema.safeParse(data);
    if (!parsed.success) throw new ExecutionApiError('INVALID_REQUEST', false);
    options.accept?.(parsed.data);
    const issued = now();
    cached = { token: parsed.data.token, renewAt: issued + parsed.data.expires_in * 500, expiresAt: issued + parsed.data.expires_in * 1000 - 5000 };
    return parsed.data.token;
  };
  return async () => {
    const current = cached, time = now();
    if (current && time < current.renewAt) return current.token;
    pending ??= exchange().finally(() => { pending = undefined; });
    try { return await pending; }
    // During a control-plane blip keep using a still-valid token instead of failing work.
    catch (error) { if (current && time < current.expiresAt) return current.token; throw error; }
  };
}
export function workloadTokenSource(options: WorkloadTokenOptions): () => Promise<string> {
  // The Pod name is the Worker identity; a mismatch means a wrong mount or ServiceAccount.
  return exchangeTokenSource({ ...options, route: ApiRoutes.workloadToken, schema: WorkloadTokenSchema,
    accept: value => { if (value.subject !== options.workerId) throw new ExecutionApiError('FORBIDDEN', false); } });
}
/** Temporal namespace token (gRPC Authorization) for the calling ServiceAccount. */
export function temporalTokenSource(options: Omit<WorkloadTokenOptions, 'workerId'>): () => Promise<string> {
  return exchangeTokenSource({ ...options, route: ApiRoutes.temporalToken, schema: TemporalTokenSchema });
}

export class ExecutionApi {
  private control: string;
  private ingest: string;
  private fetcher: typeof fetch;
  private timeout: number;
  constructor(private options: ApiOptions) {
    this.control = validateApiUrl(options.controlUrl); this.ingest = validateApiUrl(options.ingestUrl);
    this.fetcher = options.fetch ?? fetch; this.timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeout) || this.timeout < 10 || this.timeout > 10_000) throw new Error('HTTP timeout must be 10..10000 ms');
  }
  private async request<T>(base: string, path: string, schema: z.ZodType<T>, body: unknown, budget: RequestBudget = {}): Promise<T> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new ExecutionApiError('INVALID_REQUEST', false);
    const attempts = budget.attempts ?? 2;
    for (let attempt = 1; ; attempt++) {
      budget.signal?.throwIfAborted();
      const remaining = (budget.deadline ?? Infinity) - Date.now();
      if (remaining <= 0) throw new ExecutionApiError('BUDGET_EXHAUSTED', false);
      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(this.timeout, remaining)));
      const signal = budget.signal ? AbortSignal.any([budget.signal, timeoutSignal]) : timeoutSignal;
      try {
        const token = (await this.options.token()).trim();
        if (!token || /\s/.test(token)) throw new ExecutionApiError('UNAUTHENTICATED', false);
        const response = await this.fetcher(new URL(path, base), { method: serialized === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(budget.traceparent && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(budget.traceparent) ? { traceparent: budget.traceparent } : {}) }, body: serialized, signal });
        let size = 0;
        const chunks: Uint8Array[] = [];
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
              if (size > MAX_BODY_BYTES * 2) { await reader.cancel(); throw new ExecutionApiError('INVALID_REQUEST', false); }
              chunks.push(next.value);
            }
          } finally { reader.releaseLock(); }
        }
        let data: unknown;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ExecutionApiError('INVALID_REQUEST', false); }
        if (!response.ok) {
          const parsed = ApiErrorSchema.safeParse(data);
          if (!parsed.success) throw new ExecutionApiError('INVALID_REQUEST', false);
          throw new ExecutionApiError(parsed.data.error.code, parsed.data.error.retryable, parsed.data.error.correlation_id);
        }
        const parsed = schema.safeParse(data);
        if (!parsed.success) throw new ExecutionApiError('INVALID_REQUEST', false);
        return parsed.data;
      } catch (cause) {
        budget.signal?.throwIfAborted();
        const error = cause instanceof ExecutionApiError ? cause : new ExecutionApiError('UNAVAILABLE', true);
        if (!error.retryable || attempt >= attempts) throw error;
        const wait = Math.min(200 * attempt, (budget.deadline ?? Infinity) - Date.now());
        if (wait <= 0) throw new ExecutionApiError('BUDGET_EXHAUSTED', false);
        await delay(wait, undefined, { signal: budget.signal });
      }
    }
  }
  session(budget?: RequestBudget) { return this.request(this.control, ApiRoutes.session, SessionSchema, undefined, budget); }
  input(id: string, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.input(id), PlanInputSchema, undefined, budget); }
  agentInput(id: string, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.agentInput(id), AgentInputSchema, undefined, budget); }
  async receipt(id: string, budget?: RequestBudget): Promise<Receipt | null> {
    try { return await this.request(this.control, ApiRoutes.receipt(id), ReceiptSchema, undefined, budget); }
    catch (error) { if (error instanceof ExecutionApiError && error.code === 'NOT_FOUND') return null; throw error; }
  }
  event(id: string, event: ExecutionEvent, budget?: RequestBudget) {
    return this.request(this.control, ApiRoutes.events(id), z.strictObject({ accepted: z.literal(true) }), ExecutionEventSchema.parse(event), budget);
  }
  /** Proxy Manager: report observations, receive this server's assignments and renewed lease. */
  proxySync(report: ProxySyncRequest, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.proxySync, ProxySyncResponseSchema, ProxySyncRequestSchema.parse(report), budget); }
  heartbeat(value: Heartbeat, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.heartbeat, WorkerSchema, HeartbeatSchema.parse(value), budget); }
  dataApiPermit(value: unknown, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.dataApiPermit, DataApiPermitSchema, DataApiPermitRequestSchema.parse(value), budget); }
  /** Record why a permitted Data API request failed (best effort; the console's failure breakdown). */
  dataApiFailure(value: unknown, budget?: RequestBudget) { return this.request(this.control, ApiRoutes.dataApiFailure, z.strictObject({ recorded: z.boolean() }), DataApiFailureReportSchema.parse(value), budget); }
  async submit(raw: Submission, budget: RequestBudget = {}): Promise<Receipt> {
    const submission = SubmissionSchema.parse(raw);
    // Read-before-write also handles a previous Activity dying after the Store commit.
    const existing = await this.receipt(submission.submission_id, budget);
    if (existing) return checkReceipt(submission, existing);
    for (let attempt = 1; ; attempt++) {
      try {
        return checkReceipt(submission, await this.request(this.ingest, ApiRoutes.submissions, ReceiptSchema, submission, { ...budget, attempts: 1 }));
      } catch (error) {
        if (!(error instanceof ExecutionApiError) || !error.retryable) throw error;
        // An unavailable receipt query must throw; it is never interpreted as absence.
        const receipt = await this.receipt(submission.submission_id, budget);
        if (receipt) return checkReceipt(submission, receipt);
        if (attempt >= (budget.attempts ?? 2)) throw error;
      }
    }
  }
}
export function checkReceipt(submission: Submission, receipt: Receipt): Receipt {
  if (receipt.submission_id !== submission.submission_id || receipt.plan_id !== submission.plan_id || receipt.domain !== submission.domain || receipt.logical_batch_key !== submission.logical_batch_key || receipt.payload_hash !== submission.payload_hash) throw new ExecutionApiError('CONFLICT', false);
  return receipt;
}
