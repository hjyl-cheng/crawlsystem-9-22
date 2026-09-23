import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection,Client } from '@temporalio/client';
import { NativeConnection,Worker } from '@temporalio/worker';
import { temporalOptions } from '../../apps/control-api/src/temporal-config.ts';
const options=temporalOptions(),id=`m1-readiness-${randomUUID()}`;
const connection=await Connection.connect({address:options.address,tls:options.tls,connectTimeout:'10s'});
let native:NativeConnection|undefined;
try {
  native=await NativeConnection.connect({address:options.address,tls:options.tls});
  const client=new Client({connection,namespace:options.namespace});
  const worker=await Worker.create({connection:native,namespace:options.namespace,taskQueue:id,identity:'m1-main-readiness',
    workflowsPath:fileURLToPath(new URL('../../tests/integration/temporal-readiness-workflow.ts',import.meta.url)),
    activities:{readinessEcho:async(value:string)=>value},maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2,maxCachedWorkflows:2,
    maxConcurrentActivityTaskPolls:1,maxConcurrentWorkflowTaskPolls:1});
  const result=await worker.runUntil(()=>client.workflow.execute('m1ReadinessWorkflow',{workflowId:id,taskQueue:id,args:[id],workflowExecutionTimeout:'30 seconds'}));
  if(result!==id)throw new Error('Temporal readiness result mismatch');
  console.log(JSON.stringify({namespace:options.namespace,workflow_id:id,result:'PASSED',tls:true,scope:'TypeScript SDK Workflow/Activity readiness; not the M1 business workflow'},null,2));
} finally {await native?.close();await connection.close();}
