import { randomUUID } from 'node:crypto';
import { Context, heartbeat, CancelledFailure, ApplicationFailure } from '@temporalio/activity';
import { contentHash, fixtureSubmission } from '@crawlsystem/contracts/hash';
import { ExecutionApi, ExecutionApiError, checkReceipt } from '@crawlsystem/execution-client/http';
import { type Domain, type ErrorCode, type ExecutionEvent, type FixtureWorkflowResult, type PlanInput, type PlanStatus, type WorkflowInput } from '@crawlsystem/contracts';

export interface ExecutionDescriptor { deadlineAt: number; maxAttempts: number; status: PlanStatus; }
export interface ActivityOptions {
  api: ExecutionApi; workerId: string; workspaceId: string;
  enter: (planId: string) => () => void;
  log: (record: Record<string, unknown>) => void;
}
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
  const read = async (ref: WorkflowInput, deadline?: number) => {
    const value = await api.input(ref.plan_id, { signal: Context.current().cancellationSignal, deadline });
    verifyContext(ref, value, options.workspaceId);
    return value;
  };
  const event = (ref: WorkflowInput, kind: ExecutionEvent['kind'], phase: string, message: string, domain: Domain | null = null, errorCode?: ErrorCode) =>
    api.event(ref.plan_id, { event_id: randomUUID(), execution_epoch: ref.execution_epoch, worker_id: workerId, kind, phase, domain,
      message, ...(errorCode ? { error_code: errorCode } : {}) }, { signal: Context.current().cancellationSignal });

  async function activity<T>(ref: WorkflowInput, phase: string, work: () => Promise<T>): Promise<T> {
    const leave = options.enter(ref.plan_id);
    const context = Context.current();
    const beat = () => heartbeat({ plan_id: ref.plan_id, phase });
    beat(); const timer = setInterval(beat, 1000);
    try { return await work(); }
    catch (cause) {
      if (context.cancellationSignal.aborted) throw new CancelledFailure('Execution interrupted; recover using original input and receipts');
      const error = cause instanceof ExecutionApiError ? cause : new ExecutionApiError('INTERNAL_ERROR', false);
      const record = { worker_id: workerId, plan_id: ref.plan_id, workflow_id: ref.workflow_id, execution_epoch: ref.execution_epoch,
        phase, error_code: error.code, retryable: error.retryable, correlation_id: error.correlationId, attempt: context.info.attempt };
      options.log(record);
      await event(ref, 'ERROR', phase, `${error.code}; retryable=${error.retryable}; attempt=${context.info.attempt}${error.correlationId ? `; correlation=${error.correlationId.slice(0,160)}` : ''}`, null, error.code).catch(() => {});
      throw ApplicationFailure.create({ message: `Execution ${phase}: ${error.code}`, type: error.code, nonRetryable: !error.retryable,
        details: [{ code: error.code, phase, retryable: error.retryable, plan_id: ref.plan_id }] });
    } finally { clearInterval(timer); leave(); }
  }

  return {
    async loadExecution(ref: WorkflowInput): Promise<ExecutionDescriptor> {
      return activity(ref, 'INPUT', async () => {
        const value = await read(ref);
        return { deadlineAt: Date.parse(value.input.deadline_at), maxAttempts: value.input.max_attempts, status: value.plan.status };
      });
    },
    async executeFixture(ref: WorkflowInput, descriptor: ExecutionDescriptor): Promise<FixtureWorkflowResult> {
      return activity(ref, 'SUBMISSION', async () => {
        let value = await read(ref, descriptor.deadlineAt);
        if (Date.parse(value.input.deadline_at) !== descriptor.deadlineAt || value.input.max_attempts !== descriptor.maxAttempts) throw new ExecutionApiError('INPUT_MISMATCH', false);
        if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        await event(ref, 'STARTED', 'FIXTURE', 'Reading frozen test sample; no real collection or proxy');
        for (const domain of ['ABOUT','VIDEO'] as const) {
          if (!value.input.required_domains.includes(domain)) continue;
          // Use the original epoch, including while inspecting receipts of a cancelled run.
          const submission = fixtureSubmission({ ...value, plan: { ...value.plan, execution_epoch: ref.execution_epoch } }, domain);
          const checkpoint = value.receipts.find(receipt => receipt.submission_id === submission.submission_id);
          const receipt = checkpoint ? checkReceipt(submission, checkpoint) : await api.submit(submission, {
            deadline: descriptor.deadlineAt, signal: Context.current().cancellationSignal,
          });
          heartbeat({ plan_id: ref.plan_id, phase: domain, submission_id: receipt.submission_id });
          await event(ref, 'PROGRESS', domain, `APPLIED receipt=${receipt.submission_id}`, domain);
          value = await read(ref, descriptor.deadlineAt);
          if (terminal(value.plan.status)) return { plan_id: ref.plan_id, status: value.plan.status };
        }
        // Store is authoritative, including missing domains and concurrent cancellation.
        value = await read(ref, descriptor.deadlineAt);
        if (!terminal(value.plan.status)) {
          await event(ref, 'WAITING', 'DEPENDENCY', 'Required domain is pending; real Agent/API is not implemented in M1', null, 'DEPENDENCY_NOT_IMPLEMENTED');
          value = await read(ref, descriptor.deadlineAt);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
    async settleExecution(ref: WorkflowInput, failure?: ErrorCode): Promise<FixtureWorkflowResult> {
      return activity(ref, 'SETTLE', async () => {
        let value = await read(ref);
        if (!terminal(value.plan.status) && failure) {
          await event(ref, 'FAILED', 'SETTLE', `Execution stopped: ${failure}`, null, failure);
          value = await read(ref);
        }
        return { plan_id: ref.plan_id, status: value.plan.status };
      });
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
