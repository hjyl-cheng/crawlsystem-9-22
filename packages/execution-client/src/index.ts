import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { defaultPayloadConverter, WorkflowIdReusePolicy } from '@temporalio/common';
import { z } from 'zod';
import { IdSchema, WORKFLOW_TYPE, WorkflowInputSchema, type WorkflowInput, type WorkflowStarter } from '@crawlsystem/contracts';
import { validateTemporalOptions, type TemporalOptions } from './config.ts';

export class WorkflowIdentityConflict extends Error {
  constructor() { super('Existing Workflow does not match the frozen execution identity'); this.name = 'WorkflowIdentityConflict'; }
}

export function validateWorkflowInput(value: WorkflowInput): WorkflowInput {
  const input = WorkflowInputSchema.parse(value);
  if (input.workflow_id !== `m1/${input.workspace_id}/${input.plan_id}`) throw new WorkflowIdentityConflict();
  return input;
}

/** Inspect the first history event, not mutable memo or a caller-supplied run ID. */
export function workflowStarter(client: Client, taskQueue: string): WorkflowStarter {
  async function verify(input: WorkflowInput, runId?: string) {
    const handle = client.workflow.getHandle(input.workflow_id, runId);
    const description = await handle.describe();
    if (description.type !== WORKFLOW_TYPE || description.taskQueue !== taskQueue) throw new WorkflowIdentityConflict();
    // Fetch only the first page: histories and payloads are never copied into the dispatcher.
    const history = await client.workflowService.getWorkflowExecutionHistory({
      namespace: client.options.namespace, execution: { workflowId: input.workflow_id, runId: description.runId }, maximumPageSize: 1,
    });
    const started = history.history?.events?.[0]?.workflowExecutionStartedEventAttributes;
    const payloads = started?.input?.payloads;
    if (started?.workflowType?.name !== WORKFLOW_TYPE || payloads?.length !== 1) throw new WorkflowIdentityConflict();
    let original: WorkflowInput;
    try { original = validateWorkflowInput(defaultPayloadConverter.fromPayload(payloads[0]!)); }
    catch { throw new WorkflowIdentityConflict(); }
    if (Object.keys(input).some(key => input[key as keyof WorkflowInput] !== original[key as keyof WorkflowInput])) throw new WorkflowIdentityConflict();
    return { workflow_id: input.workflow_id, run_id: description.runId };
  }
  return {
    async start(raw) {
      const input = validateWorkflowInput(raw);
      try {
        const handle = await client.workflow.start(WORKFLOW_TYPE, {
          workflowId: input.workflow_id, taskQueue, args: [input],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          // The immutable business deadline is read by Activity. This is a final safety ceiling.
          workflowExecutionTimeout: '31 minutes', workflowTaskTimeout: '10 seconds',
        });
        return { workflow_id: input.workflow_id, run_id: handle.firstExecutionRunId };
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return verify(input);
        // Start may have committed before the response was lost. A missing execution or
        // failed reconciliation leaves the durable intent pending, never acknowledged.
        try { return await verify(input); }
        catch (verificationError) {
          if (verificationError instanceof WorkflowIdentityConflict) throw verificationError;
          throw error;
        }
      }
    },
    async cancel(workflowId) {
      const identity = /^m1\/(.+)\/([^/]+)$/.exec(workflowId);
      if (!identity || !IdSchema.safeParse(identity[1]).success || !z.uuid().safeParse(identity[2]).success) throw new WorkflowIdentityConflict();
      // NOT_FOUND remains retryable by the intent dispatcher: a START RPC may still
      // be in flight. Acknowledging an absent Workflow would lose that cancellation.
      const handle = client.workflow.getHandle(workflowId);
      const description = await handle.describe();
      if (description.type !== WORKFLOW_TYPE || description.taskQueue !== taskQueue) throw new WorkflowIdentityConflict();
      if (description.status.name !== 'RUNNING') return;
      try { await client.workflow.getHandle(workflowId, description.runId).cancel(); }
      catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        const latest = await handle.describe();
        if (latest.status.name === 'RUNNING') throw error;
      }
    },
  };
}

export async function createWorkflowStarter(options: TemporalOptions): Promise<WorkflowStarter & { close(): Promise<void> }> {
  validateTemporalOptions(options);
  const connection = await Connection.connect({ address: options.address, tls: options.tls, connectTimeout: '10 seconds' });
  const starter = workflowStarter(new Client({ connection, namespace: options.namespace }), options.taskQueue);
  return {
    start: input => connection.withDeadline(Date.now() + 9000, () => starter.start(input)),
    cancel: id => connection.withDeadline(Date.now() + 9000, () => starter.cancel(id)),
    close: () => connection.close(),
  };
}
