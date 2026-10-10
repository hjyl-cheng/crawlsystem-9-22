import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createPool } from '@crawlsystem/store/config';
import { contentHash } from '@crawlsystem/contracts/hash';
import { CONTRACT_VERSION,type PlanInput } from '@crawlsystem/contracts';
import { toPlan } from '@crawlsystem/store';
import { MinioStore,RawArchive,type ObjectStore,type RawUnit } from '../../apps/execution-worker/src/raw-archive.ts';
import { RawParser } from '../../apps/raw-parser/src/parser.ts';
const pool=createPool(),evidence=JSON.parse(readFileSync('.runtime/r2/preview-evidence.json','utf8'));
const kubectl=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const credentials=JSON.parse(kubectl(['-n','crawler','get','secret','minio-crawl-parser','-o','json'])).data;
const source=new MinioStore(`http://${kubectl(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}'])}:9000`,'crawl-raw',Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
const memory=()=>{const values=new Map<string,Uint8Array>();const store:ObjectStore={get:async key=>values.get(key)??null,put:async(key,bytes)=>{values.set(key,bytes);}};return {values,store};};
const raw=memory(),parsed=memory(),checks:unknown[]=[];
const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['observed_at','collected_at','listed_at','comments_ref','comments_summary'].includes(key)).map(([k,v])=>[k,normalize(v)])):value;
try {
  const schema=(await pool.query("SELECT CASE WHEN to_regclass('control.plans') IS NULL THEN 'm1' ELSE 'control' END AS s")).rows[0].s;
  const row=(await pool.query(`SELECT * FROM ${schema}.plans WHERE plan_id=$1`,[evidence.plan_id])).rows[0];
  const input={...row.frozen_input,pipeline_version:'r3.v1'},planId=randomUUID(),workspace='r3-offline-replay';
  const plan={...toPlan(row),workspace_id:workspace,plan_id:planId,workflow_id:`m1/${workspace}/${planId}`,input_hash:contentHash(input)};
  const context:PlanInput={plan,input,domains:[],receipts:[],video_targets:evidence.targets};
  const owner={schema_version:CONTRACT_VERSION,workspace_id:workspace,plan_id:planId,execution_epoch:1,input_hash:plan.input_hash,workflow_id:plan.workflow_id};
  const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>context,publish:async()=>{}});
  for(const [step,id] of [['ABOUT','channel'],['TARGETS','uploads'],...evidence.targets.map((id:string)=>['VIDEO-0',id])]) {
    const bytes=await source.get(`v1/m1-main/${evidence.plan_id}/1/${step}/${id}.json.gz`,AbortSignal.timeout(20000));assert.ok(bytes);
    const unit:RawUnit=JSON.parse(gunzipSync(bytes).toString()),original=structuredClone(unit.result);
    unit.owner=owner;unit.result={projection:'intentionally unusable'};
    const ref=await new RawArchive(raw.store,{async send(){}}).save(unit,new AbortController().signal);
    const fact=await parser.parse(ref,AbortSignal.timeout(60000));assert.ok(fact);
    if(fact.kind==='TARGETS')assert.deepEqual(fact.payload.video_ids,(original as any).ids);
    else if(fact.kind==='VIDEO' && !('unavailable' in fact.payload)) {
      const payload=structuredClone(fact.payload);
      if(payload.comments_ref)payload.comments_first_page=JSON.parse(gunzipSync(parsed.values.get(payload.comments_ref.key)!).toString());
      assert.deepEqual(normalize(payload),normalize(original));
    }else assert.deepEqual(normalize(fact.payload),normalize(original));
    checks.push({step,unit_id:id,raw_sha256:createHash('sha256').update(bytes).digest('hex'),responses:unit.responses.length,result:'PASSED'});
  }
  const result={result:'PASSED',source_plan:evidence.plan_id,method:'Independent parser replays captured HTTP responses with the compatibility projection replaced; no new YouTube request',checks};
  mkdirSync('.runtime/r3',{recursive:true,mode:0o700});writeFileSync('.runtime/r3/replay-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await pool.end();}
