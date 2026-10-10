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
    const text=await response.text(),body:unknown=(()=>{try{return JSON.parse(text);}catch{return undefined;}})();
    const failure=(code:ConstructorParameters<typeof ExecutionApiError>[0],retryable:boolean)=>Object.assign(new ExecutionApiError(code,retryable),{raw_responses:[{endpoint:'local:profile-agent',method:'POST',status:response.status,captured_at:new Date().toISOString(),body:text}]});
    // 422: this input cannot be profiled (an incomplete estimate is never submitted); retrying the same input will not help.
    if (response.status === 422) throw failure('INVALID_REQUEST', false);
    if (!response.ok) throw failure('UNAVAILABLE', true);
    const parsed = AgentProfileSchema.safeParse(body);
    if (!parsed.success) throw failure('INTERNAL_ERROR', false);
    return parsed.data;
  }
}
