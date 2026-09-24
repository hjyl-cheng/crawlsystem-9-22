import { randomUUID } from 'node:crypto';
import { createFrozenFixture } from '@crawlsystem/contracts/fixtures';
import { contentHash } from '@crawlsystem/contracts/hash';
import { CONTRACT_VERSION, type Domain, type PlanInput, type WorkflowInput, type Receipt, type Submission, type ExecutionEvent } from '@crawlsystem/contracts';

export function fixtureContext(domains: Domain[] = ['ABOUT','VIDEO']): { value: PlanInput; ref: WorkflowInput } {
  const input = createFrozenFixture(domains, new Date(Date.now() + 60_000).toISOString());
  const planId = randomUUID(), workspaceId = 'execution-test';
  const value: PlanInput = { plan: { plan_id: planId, run_id: randomUUID(), workspace_id: workspaceId, channel_id: input.channel_id,
    source_revision: 1, source_mode: 'fixture', fixture_id: input.fixture_id, required_domains: domains, status: 'QUEUED', version: 1,
    execution_epoch: 1, input_hash: contentHash(input), workflow_id: `m1/${workspaceId}/${planId}`, created_at: input.reference_time,
    updated_at: input.reference_time, finished_at: null, deadline_at: input.deadline_at, publication_status: 'NOT_ENABLED' },
    input, domains: domains.map(domain => ({ domain, state: 'PENDING', completed_at: null })), receipts: [] };
  return { value, ref: { schema_version: CONTRACT_VERSION, plan_id: planId, workspace_id: workspaceId, execution_epoch: 1,
    input_hash: value.plan.input_hash, workflow_id: value.plan.workflow_id } };
}

/** Contract-shaped HTTP double. Its assertions are module evidence, not Store validation. */
export function fixtureApi(value: PlanInput) {
  const events: ExecutionEvent[] = [], submissions: Submission[] = [];
  let dropped = false;
  const faults = { dropFirstResponse: false, unavailable: false, receiptUnavailable: false, forbid: false, cancelBeforeSubmit: false };
  const error = (code: string, retryable: boolean, status = 409) => Response.json({ error: { code, retryable, message: 'test', correlation_id: 'test-correlation' } }, { status });
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/input')) return Response.json(value);
    if (path.includes('/receipts/')) {
      if (faults.receiptUnavailable) return error('UNAVAILABLE', true, 503);
      const receipt = value.receipts.find(r => r.submission_id === path.split('/').at(-1));
      return receipt ? Response.json(receipt) : error('NOT_FOUND', false, 404);
    }
    if (path.endsWith('/events')) {
      const event = JSON.parse(String(options?.body)) as ExecutionEvent; events.push(event);
      if (!['COMPLETED','CANCELLED','FAILED'].includes(value.plan.status)) {
        if (event.kind === 'STARTED') value.plan.status = 'RUNNING';
        if (event.kind === 'WAITING') value.plan.status = 'WAITING';
        if (event.kind === 'FAILED') { value.plan.status = 'FAILED'; value.plan.execution_epoch++; }
      }
      return Response.json({ accepted: true });
    }
    if (path.endsWith('/submissions')) {
      const submission = JSON.parse(String(options?.body)) as Submission; submissions.push(submission);
      if (faults.unavailable) return error('UNAVAILABLE', true, 503);
      if (faults.forbid) return error('FORBIDDEN', false, 403);
      if (faults.cancelBeforeSubmit) { value.plan.status = 'CANCELLED'; value.plan.execution_epoch++; }
      if (value.plan.execution_epoch !== submission.execution_epoch) return error('STALE_EXECUTION', false);
      const previous = value.receipts.find(r => r.submission_id === submission.submission_id);
      if (previous) return previous.payload_hash === submission.payload_hash ? Response.json(previous) : error('CONFLICT', false);
      const receipt: Receipt = { schema_version: CONTRACT_VERSION, submission_id: submission.submission_id, plan_id: submission.plan_id,
        logical_batch_key: submission.logical_batch_key, domain: submission.domain, payload_hash: submission.payload_hash, state: 'APPLIED', applied_at: new Date().toISOString() };
      value.receipts.push(receipt);
      value.domains.find(d => d.domain === submission.domain)!.state = 'APPLIED';
      if (value.domains.every(d => d.state === 'APPLIED')) value.plan.status = 'COMPLETED';
      if (faults.dropFirstResponse && !dropped) { dropped = true; throw new TypeError('response lost'); }
      return Response.json(receipt);
    }
    throw new Error(`Unexpected test route: ${path}`);
  };
  return { fetcher, faults, events, submissions };
}
