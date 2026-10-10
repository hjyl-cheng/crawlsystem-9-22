import { createPool } from '@crawlsystem/store/config';
import { ExecutionApiError } from '@crawlsystem/execution-client/http';
import { RawReferenceSchema } from '@crawlsystem/contracts/pipeline';
import { PgSink } from './sink.ts';
import { pipelineApi,pipelineBus } from '../../raw-parser/src/runtime.ts';
const pool=createPool(),sink=new PgSink(pool),api=await pipelineApi(),bus=await pipelineBus('crawl-sink-pg');
await pool.query('SELECT 1 FROM crawl_data.ingest_units LIMIT 0');
await bus.run(['crawl.step','facts.channel','facts.video','facts.observation','facts.agent'],async m=>{
  const value=JSON.parse(m.message.value!.toString());
  if(m.topic==='crawl.step') await api.pipelineManifest(value);
  else {
    // Ignore historical R1/R2 messages that were never part of the independent pipeline.
    const raw=RawReferenceSchema.parse(value.raw),plan=await api.input(raw.plan_id);
    if(plan.input.pipeline_version!=='r3.v1') return;
    await sink.apply(value);
    await api.pipelineConfirm(raw.plan_id);
  }
},'dlq.sink');
let reconciling=false;
const reconcile=async()=>{
  if(reconciling)return;reconciling=true;
  try {
    const pending=await api.pipelineReconciliation();
    for(const unit of pending.units) {const r=RawReferenceSchema.parse(unit);await bus.send('crawl.raw',r.channel_id,r);}
    for(const owner of pending.owners) await api.pipelineConfirm(owner.plan_id);
  } catch(error) {console.log(JSON.stringify({service:'crawl-sink-pg',phase:'RECONCILE',error_code:error instanceof ExecutionApiError?error.code:'UNAVAILABLE'}));}
  finally {reconciling=false;}
};
const timer=setInterval(()=>void reconcile(),10000);await reconcile();
for(const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>{clearInterval(timer);void pool.end();});
