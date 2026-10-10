import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {OpsEventSchema,FailureReportSchema} from '@crawlsystem/contracts/analytics';
import {clickHouseFromEnv} from '../../control-api/src/analytics.ts';
import {pipelineApi,pipelineKafka,secret} from '../../raw-parser/src/runtime.ts';
import {ExecutionApiError} from '@crawlsystem/execution-client/http';
import {MinioStore} from '../../execution-worker/src/raw-archive.ts';
const ch=clickHouseFromEnv();if(!ch)throw new Error('ClickHouse credentials required');
const api=await pipelineApi(),kafka=await pipelineKafka('crawl-sink-ch'),producer=kafka.producer({idempotent:true,maxInFlightRequests:1,allowAutoTopicCreation:false}),consumer=kafka.consumer({groupId:'crawl-sink-ch',allowAutoTopicCreation:false,sessionTimeout:60000});
const dir=process.env.MINIO_CREDENTIALS_DIRECTORY??'/minio',access=await secret(dir,'access_key'),key=await secret(dir,'secret_key'),endpoint=process.env.MINIO_URL??'http://minio.storage.svc.cluster.local:9000';
const rawStore=new MinioStore(endpoint,'crawl-raw',access,key),evidenceStore=new MinioStore(endpoint,'crawl-evidence',access,key);
let stopping=false,ready=false,lastTick=Date.now(),nextMaintenance=0;
const server=createServer((req,res)=>{const ok=req.url==='/healthz'&&ready&&Date.now()-lastTick<120_000;res.statusCode=ok?200:503;res.end(ok?'ok':'starting');});server.listen(18103,'0.0.0.0');
await producer.connect();await consumer.connect();
consumer.on(consumer.events.GROUP_JOIN,()=>{ready=true;});
consumer.on(consumer.events.CRASH,e=>{ready=false;if(!stopping&&!e.payload.restart)process.exit(1);});
for(const topic of ['ops.events','dlq.parse','dlq.sink'])await consumer.subscribe({topic,fromBeginning:true});
await consumer.run({autoCommit:false,eachBatchAutoResolve:false,partitionsConsumedConcurrently:1,eachBatch:async({batch,resolveOffset,heartbeat,isRunning,isStale})=>{
  for(let start=0;start<batch.messages.length;start+=100) {
    if(!isRunning()||isStale())return;
    const messages=batch.messages.slice(start,start+100);
    if(batch.topic==='ops.events') {
      const events=messages.map(m=>OpsEventSchema.parse(JSON.parse(m.value!.toString())));
      // Archive only after both detail and deduplicated long-lived summaries are durable.
      await ch.insert(events);await heartbeat();await ch.rebuild(events);await heartbeat();
      await api.telemetryAck(events.map(e=>e.event_id),true);
    }else {
      for(const message of messages) {
        let value:Record<string,unknown>;try{value=JSON.parse(message.value!.toString());}catch{value={};}
        const modern=FailureReportSchema.safeParse(value.report);
        const report=modern.success?modern.data:FailureReportSchema.parse({report_id:`legacy:${batch.topic}:${batch.partition}:${message.offset}`,stage:batch.topic==='dlq.parse'?'PARSER':'SINK',code:typeof value.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.code)?value.code:'INVALID_MESSAGE',attempts:3});
        try{await api.failureReport(report);}catch(error) {
          if(!(error instanceof ExecutionApiError)||!['INPUT_MISMATCH','NOT_FOUND','INVALID_REQUEST'].includes(error.code))throw error;
          // Deterministically invalid owners cannot block later DLQ records or grant evidence access.
          await api.failureReport({report_id:report.report_id,stage:report.stage,code:report.code,attempts:report.attempts,source:report.source});
        }await heartbeat();
      }
    }
    const offset=messages.at(-1)!.offset;resolveOffset(offset);
    await consumer.commitOffsets([{topic:batch.topic,partition:batch.partition,offset:(BigInt(offset)+1n).toString()}]);
  }
}});
const send=async(topic:string,value:unknown,key:string)=>producer.send({topic,acks:-1,messages:[{key,value:JSON.stringify(value)}]});
process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
try {
  while(!stopping) {
    lastTick=Date.now();
    try {
      const events=await api.telemetryOutbox();
      if(events.length) {await producer.send({topic:'ops.events',acks:-1,messages:events.map(e=>({key:e.workspace_id,value:JSON.stringify(e)}))});await api.telemetryAck(events.map(e=>e.event_id),false);}
      for(const item of await api.telemetryEvidence()) {
        const bytes=await rawStore.get(item.raw.key,AbortSignal.timeout(30_000));
        if(!bytes){await api.telemetryEvidenceDone(item.failure_id,null,'MISSING');continue;}
        const hash=createHash('sha256').update(bytes).digest('hex');
        if('sha256' in item.raw && (hash!==item.raw.sha256||bytes.length!==item.raw.bytes))throw new Error('Evidence integrity failed');
        const evidenceKey=`r5/${item.workspace_id}/${item.failure_id}/${hash}.json.gz`;
        const old=await evidenceStore.get(evidenceKey,AbortSignal.timeout(30_000));
        if(old && createHash('sha256').update(old).digest('hex')!==hash)throw new Error('Evidence integrity failed');
        if(!old)await evidenceStore.put(evidenceKey,bytes,AbortSignal.timeout(30_000),true);
        await api.telemetryEvidenceDone(item.failure_id,{bucket:'crawl-evidence',key:evidenceKey,sha256:hash,bytes:bytes.length},'SAVED');
      }
      for(const replay of await api.telemetryReplays()) {
        const owner='owner' in replay.raw?replay.raw.owner:replay.raw;
        const bytes=await rawStore.get(replay.raw.key,AbortSignal.timeout(30_000));
        if(!bytes || 'sha256' in replay.raw && (bytes.length!==replay.raw.bytes||createHash('sha256').update(bytes).digest('hex')!==replay.raw.sha256)) {
          await api.telemetryReplayDone(replay.replay_id,replay.lease_token,false);continue;
        }
        await send('owner' in replay.raw?'crawl.step':'crawl.raw',replay.raw,owner.workspace_id);
        await api.telemetryReplayDone(replay.replay_id,replay.lease_token,true);
      }
      if(Date.now()>=nextMaintenance) {await api.telemetryMaintenance();nextMaintenance=Date.now()+3_600_000;}
      if(!events.length)await delay(2000);
    }catch(error){console.error(JSON.stringify({service:'crawl-sink-ch',code:error instanceof ExecutionApiError?error.code:'DEPENDENCY_UNAVAILABLE',durable_queue_retained:true}));await delay(3000);}
  }
}finally{ready=false;await consumer.disconnect();await producer.disconnect();server.close();}
