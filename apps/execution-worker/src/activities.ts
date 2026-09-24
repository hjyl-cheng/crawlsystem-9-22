import { randomUUID } from 'node:crypto';
import { Context, heartbeat, CancelledFailure, ApplicationFailure } from '@temporalio/activity';
import { contentHash, fixtureSubmission } from '@crawlsystem/contracts/hash';
import { ExecutionApi, ExecutionApiError, checkReceipt } from '@crawlsystem/execution-client/http';
import type { RequestTracing } from '@crawlsystem/http/tracing';
import { type Domain, type ErrorCode, type ExecutionEvent, type PlanWorkflowResult, type PlanInput, type PlanStatus, type WorkflowInput } from '@crawlsystem/contracts';

export interface ExecutionDescriptor { deadlineAt: number; maxAttempts: number; status: PlanStatus; }
export interface ActivityOptions {
  api: ExecutionApi; workerId: string; workspaceId: string;
  enter: (planId: string) => () => void;
  log: (record: Record<string, unknown>) => void;
  tracing?: RequestTracing;
}
/** Per-Activity trace: opened once the plan's stored context is read, then sent on every call. */
interface TraceScope { traceparent?: string; end?: (failed: boolean) => void; }
const terminal = (status: PlanStatus) => ['COMPLETED','CANCELLED','FAILED'].includes(status);

/** Validate the durable input on every attempt, including those after process replacement. */
export function verifyContext(ref: WorkflowInput, value: PlanInput, workspaceId: string): void {
  const { plan, input } = value;
  if (ref.workspace_id !== workspaceId || plan.workspace_id !== ref.workspace_id || plan.plan_id !== ref.plan_id ||
      plan.workflow_id !== ref.workflow_id || ref.workflow_id !== `m1/${ref.workspace_id}/${ref.plan_id}` ||
      plan.input_hash !== ref.input_hash || contentHash(input) !== ref.input_hash || plan.deadline_at !== input.deadline_at ||
      plan.channel_id !== input.channel_id || contentHash(plan.required_domains) !== contentHash(input.required_domains)) throw new ExecutionApiError('INPUT_MISMATCH', false);
  // A cancelled/failed plan increments its epoch. It must remain readable for reconciliation.
  if (!terminal(plan.status) && plan.execution_epoch !== ref.execution_epoch) throw new ExecutionApiError('STALE_EXECUTION', false);
}

export function createActivities(options: ActivityOptions) {
  const { api, workerId } = options;
  const read = async (ref: WorkflowInput, scope: TraceScope, deadline?: number) => {
    const value = await api.input(ref.plan_id, { signal: Context.current().cancellationSignal, deadline, traceparent: scope.traceparent });
    verifyContext(ref, value, options.workspaceId);
    if (!scope.end && options.tracing) {
      const info = Context.current().info;
      const span = options.tracing.child(value.trace_context, `activity ${info.activityType}`, { 'business.plan_id': ref.plan_id, 'temporal.attempt': info.attempt, 'worker.id': workerId });
      scope.traceparent = span.traceparent; scope.end = span.end;
    }
    return value;
  };
  const event = (ref: WorkflowInput, scope: TraceScope, kind: ExecutionEvent['kind'], phase: string, message: string, domain: Domain | null = null, errorCode?: ErrorCode) =>
    api.event(ref.plan_id, { event_id: randomUUID(), execution_epoch: ref.execution_epoch, worker_id: workerId, kind, phase, domain,
      message, ...(errorCode ? { error_code: errorCode } : {}) }, { signal: Context.current().cancellationSignal, traceparent: scope.traceparent });

  async function activity<T>(ref: WorkflowInput, phase: string, work: (scope: TraceScope) => Promise<T>): Promise<T> {
    const leave = options.enter(ref.plan_id);
    const context = Context.current(), scope: TraceScope = {};
    let failed = false;
    const beat = () => heartbeat({ plan_id: ref.plan_id, phase });
    beat(); const timer = setInterval(beat, 1000);
    try { return await work(scope); }
    catch (cause) {
      failed = true;
      if (context.cancellationSignal.aborted) throw new CancelledFailure('Execution interrupted; recover using original input and receipts');
      const error = cause instanceof ExecutionApiError ? cause : new ExecutionApiError('INTERNAL_ERROR', false);
      const record = { worker_id: workerId, plan_id: ref.plan_id, workflow_id: ref.workflow_id, execution_epoch: ref.execution_epoch,
        phase, error_code: error.code, retryable: error.retryable, correlation_id: error.correlationId, attempt: context.info.attempt };
      options.log(record);
      await event(ref, scope, 'ERROR', phase, `${error.code}; retryable=${error.retryable}; attempt=${context.info.attempt}${error.correlationId ? `; correlation=${error.correlationId.slice(0,160)}` : ''}`, null, error.code).catch(() => {});
      throw ApplicationFailure.create({ message: `Execution ${phase}: ${error.code}`, type: error.code, nonRetryable: !error.retryable,
        details: [{ code: error.code, phase, retryable: error.retryable, plan_id: ref.plan_id }] });
    } finally { clearInterval(timer); scope.end?.(failed); leave(); }
  }

  return {
    async loadExecution(ref: WorkflowInput): Promise<ExecutionDescriptor> {
      return activity(ref, 'INPUT', async scope => {
        const value = await read(ref, scope);
        return { deadlineAt: Date.parse(value.input.deadline_at), maxAttempts: value.input.max_attempts, status: value.plan.status };
      });
    },
    async executeFixture(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<PlanWorkflowResult> {
      return activity(ref, 'SUBMISSION', async scope => {
        let value = await read(ref, scope, descriptor.deadlineAt);
        if (Date.parse(value.input.deadline_at) !== descriptor.deadlineAt || value.input.max_attempts !== descriptor.maxAttempts) throw new ExecutionApiError('INPUT_MISMATCH', false);
        if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        if (value.input.source_mode !== 'fixture') {
          // Real collection lands in M2 step 4; until then the plan waits visibly instead of failing silently.
          await event(ref, scope, 'WAITING', 'COLLECTOR', 'YouTube collector is not deployed yet', null, 'DEPENDENCY_NOT_IMPLEMENTED');
          return { plan_id: ref.plan_id, status: (await read(ref, scope, descriptor.deadlineAt)).plan.status };
        }
        await event(ref, scope, 'STARTED', 'FIXTURE', 'Reading frozen test sample; no real collection or proxy');
        for (const domain of ['ABOUT','VIDEO'] as const) {
          if (!value.input.required_domains.includes(domain)) continue;
          // Use the original epoch, including while inspecting receipts of a cancelled run.
          const submission = fixtureSubmission({ ...value, plan: { ...value.plan, execution_epoch: ref.execution_epoch } }, domain);
          const checkpoint = value.receipts.find(receipt => receipt.submission_id === submission.submission_id);
          const receipt = checkpoint ? checkReceipt(submission, checkpoint) : await api.submit(submission, {
            deadline: descriptor.deadlineAt, signal: Context.current().cancellationSignal, traceparent: scope.traceparent,
          });
          heartbeat({ plan_id: ref.plan_id, phase: domain, submission_id: receipt.submission_id });
          await event(ref, scope, 'PROGRESS', domain, `APPLIED receipt=${receipt.submission_id}`, domain);
          value = await read(ref, scope, descriptor.deadlineAt);
          if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        }
        // Store is authoritative, including missing domains and concurrent cancellation.
        value = await read(ref, scope, descriptor.deadlineAt);
        if (!terminal(value.plan.status)) {
          await event(ref, scope, 'WAITING', 'DEPENDENCY', 'Required domain is pending; real Agent/API is not implemented in M1', null, 'DEPENDENCY_NOT_IMPLEMENTED');
          value = await read(ref, scope, descriptor.deadlineAt);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
    async settleExecution(ref: WorkflowInput, failure?: ErrorCode): Promise<PlanWorkflowResult> {
      return activity(ref, 'SETTLE', async scope => {
        let value = await read(ref, scope);
        if (!terminal(value.plan.status) && failure) {
          await event(ref, scope, 'FAILED', 'SETTLE', `Execution stopped: ${failure}`, null, failure);
          value = await read(ref, scope);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
