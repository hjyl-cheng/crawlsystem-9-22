import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { workflowStarter } from '@crawlsystem/execution-client';
import { temporalOptions } from '@crawlsystem/execution-client/config';
import { fixtureContext } from './support.ts';
import type { Activities } from '../src/activities.ts';

Runtime.install({ logger: new DefaultLogger('ERROR') });
const unexpected = () => { throw new Error('not used by fixture plans'); };
const unusedCollector = { collectAbout: unexpected, listTargets: unexpected, collectVideoBatch: unexpected, sampleRecentVideos: unexpected, collectAgent: unexpected, awaitAgent: unexpected,waitPipeline:unexpected };
test('Temporal SDK workflow coordination, waiting, retries, cancellation and history replay', { timeout: 180_000 }, async t => {
  const existing = process.env.EXECUTION_TEMPORAL_EXISTING === 'true';
  const options = existing ? temporalOptions() : undefined;
  const env = options ? await TestWorkflowEnvironment.createFromExistingServer({ address: options.address, namespace: options.namespace, connectionOptions: { tls: options.tls } }) : await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const workflowBundle = { code: await readFile(new URL('../dist/workflow-bundle.cjs', import.meta.url), 'utf8') };
    async function scenario(name: string, run: (activities: Activities, state: { executions: number; settlements: number }) => Promise<void>, behavior: 'success' | 'waiting' | 'retry' | 'cancel') {
      await t.test(name, async () => {
        const queue = `execution-sdk-${randomUUID()}`, { ref } = fixtureContext();
        const starter = workflowStarter(env.client, queue);
        const state = { executions: 0, settlements: 0 };
        let ready!: () => void;
        const reached = new Promise<void>(resolve => { ready = resolve; });
        const deadline = await env.currentTimeMs() + (behavior === 'waiting' ? 3000 : 60_000);
        const activities: Activities = {
          loadExecution: async () => ({ deadlineAt: deadline, maxAttempts: 3, status: 'QUEUED' }),
          executeFixture: async () => {
            state.executions++; ready();
            if (behavior === 'retry') throw ApplicationFailure.create({ message: 'temporary failure', type: 'UNAVAILABLE', details: [{ code: 'UNAVAILABLE' }] });
            return { plan_id: ref.plan_id, status: behavior === 'success' ? 'COMPLETED' : 'WAITING' };
          },
          settleExecution: async (_ref, failure) => { state.settlements++; return { plan_id: ref.plan_id, status: failure ? 'FAILED' : 'CANCELLED' }; },
          ...unusedCollector,
        };
        const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: queue, workflowBundle, activities,
          maxConcurrentActivityTaskExecutions: 2, maxConcurrentWorkflowTaskExecutions: 2, maxCachedWorkflows: 5,
          maxConcurrentActivityTaskPolls: 1, maxConcurrentWorkflowTaskPolls: 1, shutdownGraceTime: '1 second' });
        await worker.runUntil(async () => {
          const first = await starter.start(ref);
          assert.deepEqual(await starter.start(ref), first);
          const handle = env.client.workflow.getHandle(ref.workflow_id);
          if (behavior === 'cancel') {
            const stop = new AbortController();
            try { await Promise.race([reached, delay(20_000, undefined, { signal: stop.signal }).then(() => { throw new Error('Activity did not start'); })]); }
            finally { stop.abort(); }
            await starter.cancel(ref.workflow_id); await assert.rejects(handle.result());
          } else if (behavior === 'retry') await assert.rejects(handle.result());
          else assert.equal((await handle.result() as { status: string }).status, behavior === 'success' ? 'COMPLETED' : 'FAILED');
          await run(activities, state);
          assert.deepEqual(await starter.start(ref), first, 'closed Workflow must not be started again');
          await assert.rejects(starter.start({ ...ref, input_hash: `sha256:${'a'.repeat(64)}` }));
          const history = await handle.fetchHistory();
          await Worker.runReplayHistory({ workflowBundle }, history);
          // Decode the payload bytes: a search of serialized base64 cannot detect
          // accidentally placing a large sample into Workflow history.
          function checkPayloads(value: unknown): void {
            if (!value || typeof value !== 'object') return;
            if ('data' in value && value.data instanceof Uint8Array) {
              assert.ok(value.data.byteLength < 4096);
              assert.ok(!Buffer.from(value.data).toString('utf8').includes('comments_first_page'));
            }
            for (const entry of Object.values(value)) if (!(entry instanceof Uint8Array)) checkPayloads(entry);
          }
          checkPayloads(history);
        });
      });
    }
    await scenario('completion and duplicate start, including after close', async (_a, state) => { assert.equal(state.executions, 1); }, 'success');
    await scenario('unimplemented dependency waits until original deadline', async (_a, state) => { assert.equal(state.executions, 1); assert.equal(state.settlements, 1); }, 'waiting');
    await scenario('retryable Activity failure exhausts exactly three attempts', async (_a, state) => { assert.equal(state.executions, 3); assert.equal(state.settlements, 1); }, 'retry');
    await scenario('cancellation interrupts durable dependency wait', async (_a, state) => { assert.equal(state.executions, 1); assert.equal(state.settlements, 1); }, 'cancel');
    await t.test('YouTube plan: About, frozen targets, each batch once with a retried failure, then completion', async () => {
      const queue = `execution-sdk-${randomUUID()}`, { ref } = fixtureContext();
      const calls: string[] = []; let failedOnce = false;
      const deadline = await env.currentTimeMs() + 600_000;
      const activities: Activities = {
        loadExecution: async () => ({ deadlineAt: deadline, maxAttempts: 3, status: 'QUEUED', sourceMode: 'youtube', requiresAgent: false }),
        executeFixture: unexpected, settleExecution: unexpected, collectAgent: unexpected, awaitAgent: unexpected, sampleRecentVideos: unexpected,waitPipeline:unexpected,
        collectAbout: async () => { calls.push('about'); return { plan_id: ref.plan_id, status: 'RUNNING' }; },
        listTargets: async () => { calls.push('targets'); return { batches: 3, status: 'RUNNING' }; },
        collectVideoBatch: async (_ref, _d, index) => {
          calls.push(`batch${index}`);
          if (index === 1 && !failedOnce) { failedOnce = true; throw ApplicationFailure.create({ message: 'proxy failure', type: 'UNAVAILABLE' }); }
          return { status: index === 2 ? 'COMPLETED' : 'RUNNING' };
        },
      };
      const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: queue, workflowBundle, activities,
        maxConcurrentActivityTaskExecutions: 2, maxCachedWorkflows: 5, shutdownGraceTime: '1 second' });
      await worker.runUntil(async () => {
        await workflowStarter(env.client, queue).start(ref);
        const handle = env.client.workflow.getHandle(ref.workflow_id);
        assert.equal((await handle.result() as { status: string }).status, 'COMPLETED');
        assert.deepEqual(calls, ['about', 'targets', 'batch0', 'batch1', 'batch1', 'batch2']);
        await Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory());
      });
    });
    await t.test('YouTube plan requiring AGENT: profile after the last batch, retried once, then completion', async () => {
      const queue = `execution-sdk-${randomUUID()}`, { ref } = fixtureContext();
      const calls: string[] = []; let failedOnce = false;
      const deadline = await env.currentTimeMs() + 600_000;
      const activities: Activities = {
        loadExecution: async () => ({ deadlineAt: deadline, maxAttempts: 3, status: 'QUEUED', sourceMode: 'youtube', requiresAgent: true }),
        executeFixture: unexpected, settleExecution: unexpected, awaitAgent: unexpected,waitPipeline:unexpected,
        collectAbout: async () => { calls.push('about'); return { plan_id: ref.plan_id, status: 'RUNNING' }; },
        listTargets: async () => { calls.push('targets'); return { batches: 1, status: 'RUNNING' }; },
        collectVideoBatch: async () => { calls.push('batch0'); return { status: 'RUNNING' }; },
        sampleRecentVideos: async () => { calls.push('samples'); return { status: 'RUNNING' }; },
        collectAgent: async () => {
          calls.push('agent');
          if (!failedOnce) { failedOnce = true; throw ApplicationFailure.create({ message: 'profile agent unavailable', type: 'UNAVAILABLE' }); }
          return { status: 'COMPLETED' };
        },
      };
      const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: queue, workflowBundle, activities,
        maxConcurrentActivityTaskExecutions: 2, maxCachedWorkflows: 5, shutdownGraceTime: '1 second' });
      await worker.runUntil(async () => {
        await workflowStarter(env.client, queue).start(ref);
        const handle = env.client.workflow.getHandle(ref.workflow_id);
        assert.equal((await handle.result() as { status: string }).status, 'COMPLETED');
        assert.deepEqual(calls, ['about', 'targets', 'batch0', 'samples', 'agent', 'agent']);
        await Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory());
      });
    });
    await t.test('R3 waits for durable data before Agent and durable Agent before completing; history replays',async()=>{
      const queue=`execution-sdk-${randomUUID()}`,{ref}=fixtureContext(),calls:string[]=[];
      const activities:Activities={...unusedCollector,
        loadExecution:async()=>({deadlineAt:await env.currentTimeMs()+600000,maxAttempts:3,status:'QUEUED',sourceMode:'youtube',requiresAgent:true,pipelineVersion:'r3.v1'}),
        executeFixture:unexpected,settleExecution:unexpected,
        collectAbout:async()=>{calls.push('about');return {plan_id:ref.plan_id,status:'RUNNING'};},
        listTargets:async()=>{calls.push('targets');return {batches:1,status:'RUNNING'};},
        collectVideoBatch:async()=>{calls.push('video');return {status:'RUNNING'};},
        sampleRecentVideos:async()=>{calls.push('sampling');return {status:'RUNNING'};},
        waitPipeline:async(_r,_d,final)=>{calls.push(final?'agent-ingested':'data-ingested');return {plan_id:ref.plan_id,status:final?'COMPLETED':'RUNNING'};},
        collectAgent:async()=>{assert.equal(calls.at(-1),'data-ingested');calls.push('agent');return {status:'RUNNING'};},
      };
      const worker=await Worker.create({connection:env.nativeConnection,namespace:env.namespace,taskQueue:queue,workflowBundle,activities,maxConcurrentActivityTaskExecutions:2,maxCachedWorkflows:5,shutdownGraceTime:'1 second'});
      await worker.runUntil(async()=>{
        await workflowStarter(env.client,queue).start(ref);const handle=env.client.workflow.getHandle(ref.workflow_id);
        assert.equal((await handle.result() as {status:string}).status,'COMPLETED');
        assert.deepEqual(calls,['about','targets','video','sampling','data-ingested','agent','agent-ingested']);
        await Worker.runReplayHistory({workflowBundle},await handle.fetchHistory());
      });
    });
    await t.test('R4 waits for ABOUT qualification before targets; rejection stops video and Agent and replays',async()=>{
      for(const rejected of [false,true]) {
        const queue=`execution-sdk-${randomUUID()}`,{ref}=fixtureContext(),calls:string[]=[];
        const activities:Activities={...unusedCollector,
          loadExecution:async()=>({deadlineAt:await env.currentTimeMs()+600000,maxAttempts:3,status:'QUEUED',sourceMode:'youtube',requiresAgent:false,pipelineVersion:'r3.v1',requiresQualification:true}),
          executeFixture:unexpected,settleExecution:unexpected,
          collectAbout:async()=>{calls.push('about');return {plan_id:ref.plan_id,status:'RUNNING'};},
          waitPipeline:async(_r,_d,_final,aboutOnly)=>{calls.push(aboutOnly?'qualification':'data-ingested');return {plan_id:ref.plan_id,status:aboutOnly?(rejected?'CANCELLED':'RUNNING'):'COMPLETED'};},
          listTargets:async()=>{assert.equal(calls.at(-1),'qualification');calls.push('targets');return {batches:0,status:'RUNNING'};},
          sampleRecentVideos:async()=>({status:'RUNNING'}),
        };
        const worker=await Worker.create({connection:env.nativeConnection,namespace:env.namespace,taskQueue:queue,workflowBundle,activities,maxConcurrentActivityTaskExecutions:2,maxCachedWorkflows:5,shutdownGraceTime:'1 second'});
        await worker.runUntil(async()=>{
          await workflowStarter(env.client,queue).start(ref);const handle=env.client.workflow.getHandle(ref.workflow_id);
          assert.equal((await handle.result() as {status:string}).status,rejected?'CANCELLED':'COMPLETED');
          assert.deepEqual(calls,rejected?['about','qualification']:['about','qualification','targets','data-ingested']);
          await Worker.runReplayHistory({workflowBundle},await handle.fetchHistory());
        });
      }
    });
  } finally { await env.teardown(); }
});
