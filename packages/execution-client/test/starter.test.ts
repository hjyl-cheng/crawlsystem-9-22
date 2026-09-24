import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { defaultPayloadConverter, WorkflowIdReusePolicy } from '@temporalio/common';
import { WORKFLOW_TYPE } from '@crawlsystem/contracts';
import { workflowStarter, WorkflowIdentityConflict } from '../src/index.ts';
import { fixtureContext } from '../../../apps/execution-worker/test/support.ts';

function fake() {
  const { ref } = fixtureContext(); let calls = 0, cancelled = 0;
  const state = { original: { ...ref }, type: WORKFLOW_TYPE as string, status: 'RUNNING', loss: false, missing: false };
  const client = { options: { namespace: 'test' }, workflow: {
    async start(_type: unknown, options: { workflowIdReusePolicy: unknown }) {
      calls++; assert.equal(options.workflowIdReusePolicy, WorkflowIdReusePolicy.REJECT_DUPLICATE);
      if (state.loss) throw new Error('transport response lost');
      throw new WorkflowExecutionAlreadyStartedError('already started', ref.workflow_id, WORKFLOW_TYPE);
    },
    getHandle() { return {
      async describe() { if (state.missing) throw new Error('missing'); return { type: state.type, taskQueue: 'test', runId: 'original-run', status: { name: state.status } }; },
      async cancel() { cancelled++; },
    }; },
  }, workflowService: { async getWorkflowExecutionHistory() { return { history: { events: [{ workflowExecutionStartedEventAttributes: {
    workflowType: { name: state.type }, input: { payloads: [defaultPayloadConverter.toPayload(state.original)] },
  } }] } }; } } } as unknown as Client;
  return { ref, state, starter: workflowStarter(client, 'test'), calls: () => calls, cancelled: () => cancelled };
}
test('duplicate open or closed execution returns original run only after identity verification', async () => {
  const f = fake();
  assert.equal((await f.starter.start(f.ref)).run_id, 'original-run');
  f.state.status = 'COMPLETED'; assert.equal((await f.starter.start(f.ref)).run_id, 'original-run');
  f.state.loss = true; assert.equal((await f.starter.start(f.ref)).run_id, 'original-run');
});
test('same-name wrong input and wrong type are rejected', async () => {
  const f = fake(); f.state.original.input_hash = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(f.starter.start(f.ref), WorkflowIdentityConflict);
  f.state.original = { ...f.ref }; f.state.type = 'unrelated';
  await assert.rejects(f.starter.start(f.ref), WorkflowIdentityConflict);
});
test('invalid ID is rejected before start, absent cancel remains unacknowledged', async () => {
  const f = fake(); await assert.rejects(f.starter.start({ ...f.ref, workflow_id: 'different' }), WorkflowIdentityConflict);
  assert.equal(f.calls(), 0);
  f.state.missing = true; await assert.rejects(f.starter.cancel(f.ref.workflow_id)); assert.equal(f.cancelled(), 0);
  f.state.missing = false; await f.starter.cancel(f.ref.workflow_id); assert.equal(f.cancelled(), 1);
});
test('cancel accepts all workspace IDs allowed by the shared contract', async () => {
  const f = fake(); f.ref.workspace_id = 'tenant/project'; f.ref.workflow_id = `m1/${f.ref.workspace_id}/${f.ref.plan_id}`;
  f.state.original = { ...f.ref };
  await f.starter.cancel(f.ref.workflow_id); assert.equal(f.cancelled(), 1);
});
