import { AgentProfileSchema, type AgentInput, type AgentProfile } from '@crawlsystem/contracts';
import { ExecutionApiError } from '@crawlsystem/execution-client/http';

// Client of the Profile Agent (apps/profile-agent): local-model inference over the
// Store's Agent input snapshot. The service is a pure function of its input, so a
// retried call yields the same profile and the same idempotent submission.

export class ProfileClient {
  constructor(private base: string, private fetcher: typeof fetch = fetch, private timeoutMs = 60_000) {}
  async profile(input: AgentInput, options: { signal?: AbortSignal; traceparent?: string } = {}): Promise<AgentProfile> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/v1/profile`, { method: 'POST', signal, body: JSON.stringify(input),
        headers: { 'content-type': 'application/json', ...(options.traceparent ? { traceparent: options.traceparent } : {}) } });
    } catch { throw new ExecutionApiError('UNAVAILABLE', true); }
    const body = await response.json().catch(() => undefined);
    // 422: this input cannot be profiled (an incomplete estimate is never submitted); retrying the same input will not help.
    if (response.status === 422) throw new ExecutionApiError('INVALID_REQUEST', false);
    if (!response.ok) throw new ExecutionApiError('UNAVAILABLE', true);
    const parsed = AgentProfileSchema.safeParse(body);
    if (!parsed.success) throw new ExecutionApiError('INTERNAL_ERROR', false);
    return parsed.data;
  }
}
