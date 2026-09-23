import { proxyActivities } from '@temporalio/workflow';
export async function m1ReadinessWorkflow(marker:string):Promise<string> {
  const activities=proxyActivities<{readinessEcho(value:string):Promise<string>}>({startToCloseTimeout:'5 seconds',retry:{maximumAttempts:2}});
  return activities.readinessEcho(marker);
}
