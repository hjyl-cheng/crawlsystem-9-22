import { Connection } from '@temporalio/client';
import { msToTs } from '@temporalio/common';
import { temporalOptions } from '../../apps/control-api/src/temporal-config.ts';
const options=temporalOptions();
const connection=await Connection.connect({address:options.address,tls:options.tls,connectTimeout:'10s'});
try {
  await connection.withDeadline(Date.now()+15_000,async()=>{
    try {await connection.workflowService.describeNamespace({namespace:options.namespace});}
    catch(error) {
      if((error as {code?:number}).code!==5)throw error;
      try {await connection.workflowService.registerNamespace({namespace:options.namespace,description:'Isolated M1 fixed-fixture integration',workflowExecutionRetentionPeriod:msToTs('7 days')});}
      catch(createError) {if((createError as {code?:number}).code!==6)throw createError;}
    }
    const result=await connection.workflowService.describeNamespace({namespace:options.namespace});
    console.log(JSON.stringify({namespace:result.namespaceInfo?.name,state:result.namespaceInfo?.state,retention_seconds:String(result.config?.workflowExecutionRetentionTtl?.seconds),tls:true,scope:'namespace readiness only'},null,2));
  });
} finally {await connection.close();}
