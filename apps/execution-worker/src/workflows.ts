import { proxyActivities, patched, sleep, CancellationScope, isCancellation, ApplicationFailure, ActivityFailure, ActivityCancellationType } from '@temporalio/workflow';
import type { PlanWorkflowResult, WorkflowInput, ErrorCode } from '@crawlsystem/contracts';
import type { Activities } from './activities.ts';

const bootstrap = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '100 seconds', heartbeatTimeout: '5 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', maximumInterval: '5 seconds' },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const cleanup = proxyActivities<Activities>({
  startToCloseTimeout: '15 seconds', scheduleToCloseTimeout: '35 seconds', heartbeatTimeout: '5 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second' },
});

export async function channelPlanWorkflow(ref: WorkflowInput): Promise<PlanWorkflowResult> {
  try {
    const descriptor = await bootstrap.loadExecution(ref);
    if (['COMPLETED','CANCELLED','FAILED'].includes(descriptor.status)) return { plan_id: ref.plan_id, status: descriptor.status };
    const remaining = descriptor.deadlineAt - Date.now();
    if (remaining <= 0) return await cleanup.settleExecution(ref, 'BUDGET_EXHAUSTED');
    if (descriptor.sourceMode === 'youtube') {
      // Real collection: upstream and proxy trouble is common and transient, so retries back off
      // for longer; every step re-reads its receipts, so a retry only redoes unfinished work.
      const collector = proxyActivities<Activities>({
        startToCloseTimeout: Math.min(10 * 60_000, remaining), scheduleToCloseTimeout: remaining, heartbeatTimeout: '30 seconds',
        retry: { maximumAttempts: Math.max(descriptor.maxAttempts, 5), initialInterval: '5 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes' },
        cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
      });
      const settled = (status: string) => ['COMPLETED', 'CANCELLED', 'FAILED'].includes(status);
      let status = (await collector.collectAbout(ref, descriptor)).status;
      if (patched('r4-about-qualification') && descriptor.pipelineVersion==='r3.v1' && descriptor.requiresQualification && !settled(status))
        status=(await collector.waitPipeline(ref,descriptor,false,true)).status;
      if (!settled(status)) {
        const targets = await collector.listTargets(ref, descriptor);
        status = targets.status;
        for (let index = 0; index < targets.batches && !settled(status); index++) status = (await collector.collectVideoBatch(ref, descriptor, index)).status;
        // Recorded before M3 step 3: no update re-read recent videos.
        if (!settled(status) && patched('m3-recent-sampling')) status = (await collector.sampleRecentVideos(ref, descriptor)).status;
      }
      if(patched('r3-durable-ingestion') && descriptor.pipelineVersion==='r3.v1' && !settled(status))
        status=(await collector.waitPipeline(ref,descriptor,!descriptor.requiresAgent)).status;
      if (settled(status) || !descriptor.requiresAgent) return { plan_id: ref.plan_id, status: status as PlanWorkflowResult['status'] };
      if (patched('m2-agent-profile')) {
        status = (await collector.collectAgent(ref, descriptor)).status;
        if(descriptor.pipelineVersion==='r3.v1' && !settled(status)) status=(await collector.waitPipeline(ref,descriptor,true)).status;
        // Every required domain is sealed once AGENT applies; anything else is a Store-side gap, never a silent success.
        return settled(status) ? { plan_id: ref.plan_id, status: status as PlanWorkflowResult['status'] } : await cleanup.settleExecution(ref, 'DOMAIN_INCOMPLETE');
      }
      // Recorded before M2 step 5: the plan waited for an Agent that did not exist yet.
      await collector.awaitAgent(ref, descriptor);
      await sleep(Math.max(1, descriptor.deadlineAt - Date.now()));
      return await cleanup.settleExecution(ref, 'BUDGET_EXHAUSTED');
    }
    const execution = proxyActivities<Activities>({
      startToCloseTimeout: Math.min(60_000, remaining), scheduleToCloseTimeout: remaining, heartbeatTimeout: '5 seconds',
      retry: { maximumAttempts: descriptor.maxAttempts, initialInterval: '1 second', maximumInterval: '5 seconds' },
      cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    });
    const result = await execution.executeFixture(ref, descriptor);
    if (['COMPLETED','CANCELLED','FAILED'].includes(result.status)) return result;
    // M1 has no Agent producer. A single durable timer preserves the original deadline
    // without repeatedly creating new Activities and resetting their retry budgets.
    await sleep(Math.max(1, descriptor.deadlineAt - Date.now()));
    return await cleanup.settleExecution(ref, 'BUDGET_EXHAUSTED');
  } catch (error) {
    if (isCancellation(error)) {
      // Cancellation authority lives in Store. Do not manufacture CANCELLED or FAILED.
      await CancellationScope.nonCancellable(() => cleanup.settleExecution(ref)).catch(() => {});
      throw error;
    }
    const cause = error instanceof ActivityFailure ? error.cause : error;
    const detail = cause instanceof ApplicationFailure ? cause.details?.[0] as { code?: ErrorCode } | undefined : undefined;
    const code = detail?.code;
    await CancellationScope.nonCancellable(() => cleanup.settleExecution(ref, code ?? 'BUDGET_EXHAUSTED')).catch(() => {});
    throw error;
  }
}
