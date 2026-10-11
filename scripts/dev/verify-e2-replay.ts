import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {Store} from '@crawlsystem/store';
import {MinioStore} from '../../apps/execution-worker/src/raw-archive.ts';
import {RawParser} from '../../apps/raw-parser/src/parser.ts';
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
const pool=createPool(),failureId='4acf3940-e4ed-4258-9a3f-b0f1d94f810d';let phase='load';
try{
  const ref=(await pool.query('SELECT raw FROM control.failures WHERE failure_id=$1',[failureId])).rows[0].raw;
  const credentials=JSON.parse(kube(['-n','crawler','get','secret','minio-crawl-parser','-o','json'])).data;
  const endpoint='http://'+kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}'])+':9000';
  const raw=new MinioStore(endpoint,'crawl-raw',Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
  const context=await new Store(pool).getInput({workspace_id:'m1-main',subject:'e2-offline-replay',role:'worker'},ref.plan_id);
  const bytes=await raw.get(ref.key,AbortSignal.timeout(15000));assert.ok(bytes);
  const unit=JSON.parse(gunzipSync(bytes).toString()),objects=new Map<string,Uint8Array>();
  const parser=new RawParser({raw,parsed:{get:async key=>objects.get(key)??null,put:async(key,data)=>{objects.set(key,data);}},loadPlan:async()=>context,publish:async()=>{}});
  phase='decode';const fact=await parser.parse(ref,AbortSignal.timeout(15000));assert.ok(fact && fact.kind==='VIDEO' && !('unavailable' in fact.payload));
  for(const field of ['source_content_id','title','published_at','content_type'] as const){phase=field;assert.deepEqual(fact.payload[field],unit.result[field],field);}
  for(const field of ['duration_seconds','view_count'] as const){phase=field;
    const decoded:Record<string,unknown>={...fact.payload[field]},original:Record<string,unknown>={...unit.result[field]};
    delete decoded.observed_at;delete original.observed_at;assert.deepEqual(decoded,original,field);
  }
  assert.equal(fact.payload.comments_first_page,null);
  const result={result:'PASSED',at:new Date().toISOString(),failure_id:failureId,plan_id:ref.plan_id,unit_id:ref.unit_id,source_sha256:ref.sha256,captured_responses:unit.responses.length,checked_fields:['source_content_id','title','published_at','content_type','duration_seconds','view_count'],parsed_objects_in_memory:objects.size,production_writes:0};
  writeFileSync('.runtime/e2/offline-replay.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}catch(error){console.error('E2 offline replay failed at '+phase+':',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();}
