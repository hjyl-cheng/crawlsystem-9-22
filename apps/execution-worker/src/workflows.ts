import { proxyActivities, sleep, CancellationScope, isCancellation, ApplicationFailure, ActivityFailure, ActivityCancellationType } from '@temporalio/workflow';
import type { FixtureWorkflowResult, WorkflowInput, ErrorCode } from '@crawlsystem/contracts';
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

export async function fixturePlanWorkflow(ref: WorkflowInput): Promise<FixtureWorkflowResult> {
  try {
    const descriptor = await bootstrap.loadExecution(ref);
    if (['COMPLETED','CANCELLED','FAILED'].includes(descriptor.status)) return { plan_id: ref.plan_id, status: descriptor.status };
    const remaining = descriptor.deadlineAt - Date.now();
    if (remaining <= 0) return await cleanup.settleExecution(ref, 'BUDGET_EXHAUSTED');
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
