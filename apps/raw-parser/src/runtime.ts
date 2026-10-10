import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Kafka, logLevel, type EachMessagePayload } from 'kafkajs';
import { ExecutionApi, ExecutionApiError, workloadTokenSource } from '@crawlsystem/execution-client/http';
import {failureEnvelope} from './failure.ts';
export const secret=async (dir:string,key:string)=>(await readFile(`${dir}/${key}`,'utf8')).trim();
export async function pipelineApi() {
  const control=process.env.CONTROL_API_URL??'http://control-api.control.svc.cluster.local:18100',pod=process.env.POD_NAME;
  if(!pod) throw new Error('Pod identity is required');
  const token=workloadTokenSource({controlUrl:control,workerId:pod,identityToken:()=>readFile(process.env.WORKLOAD_TOKEN_FILE??'/var/run/crawlsystem/identity/token','utf8')});
  return new ExecutionApi({controlUrl:control,ingestUrl:control,token});
}
export async function pipelineKafka(groupId:string) {
  const dir=process.env.KAFKA_CREDENTIALS_DIRECTORY??'/var/run/crawlsystem/kafka';
  return new Kafka({clientId:groupId,brokers:(await secret(dir,'bootstrap')).split(','),ssl:{ca:[await secret(dir,'ca.crt')]},
    sasl:{mechanism:'scram-sha-512',username:await secret(dir,'username'),password:await secret(dir,'password')},logLevel:logLevel.NOTHING,
    connectionTimeout:5000,requestTimeout:30000,retry:{retries:8}});
}
export async function pipelineBus(groupId:'crawl-parser'|'crawl-sink-pg') {
  const kafka=await pipelineKafka(groupId);
  const producer=kafka.producer({idempotent:true,maxInFlightRequests:1,allowAutoTopicCreation:false}),consumer=kafka.consumer({groupId,allowAutoTopicCreation:false,sessionTimeout:60000});
  let ready=false,stopping=false;
  const server=createServer((req,res)=>{res.statusCode=req.url==='/healthz'&&ready?200:503;res.end(ready?'ok':'starting');});
  server.listen(Number(process.env.PIPELINE_PORT??'18103'),'0.0.0.0');
  const send=async(topic:string,key:string,value:unknown)=>{await producer.send({topic,acks:-1,messages:[{key,value:JSON.stringify(value)}]});};
  await producer.connect();await consumer.connect();
  consumer.on(consumer.events.GROUP_JOIN,()=>{if(!stopping)ready=true;});
  consumer.on(consumer.events.CRASH,event=>{ready=false;if(!stopping&&!event.payload.restart)process.exit(1);});
  const stop=async()=>{if(stopping)return;stopping=true;ready=false;await consumer.disconnect();await producer.disconnect();server.close();};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  const run=async(topics:string[],handler:(message:EachMessagePayload)=>Promise<void>,dlq:'dlq.parse'|'dlq.sink')=>{
    for(const topic of topics) await consumer.subscribe({topic,fromBeginning:true});
    await consumer.run({partitionsConsumedConcurrently:1,eachMessage:async message=>{
      for(let attempt=1;;attempt++) {
        try {await handler(message);return;}
        catch(error) {
          const rawCode=(error as {code?:string}).code??(error as Error).message;
          const code=/^(INTEGRITY|REPLAY_INCOMPLETE|INVALID_FACT|INPUT_MISMATCH|TARGET_MISMATCH|CONFLICT|PLAN_TERMINAL|STALE_EXECUTION|BUDGET_EXHAUSTED|NOT_FOUND)$/.test(rawCode)?rawCode
            : (error as Error).name==='ZodError'||error instanceof SyntaxError?'INVALID_MESSAGE':undefined;
          // Retain messages during infrastructure outages. Only deterministic failures enter DLQ.
          if(!code || error instanceof ExecutionApiError && error.retryable) {
            if(attempt>=5) throw error;
          } else if(attempt>=3) {
            await send(dlq,message.message.key?.toString()??'unknown',failureEnvelope(groupId==='crawl-parser'?'PARSER':'SINK',message.topic,message.partition,message.message.offset,code,attempt,message.message.value?.toString()??''));
            console.log(JSON.stringify({service:groupId,topic:message.topic,partition:message.partition,offset:message.message.offset,error_code:code}));return;
          }
          await message.heartbeat();await delay(Math.min(attempt*1000,5000));
        }
      }
    }});ready=true;
  };
  return {run,send,stop};
}
