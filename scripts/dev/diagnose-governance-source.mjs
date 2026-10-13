import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createPool} from '@crawlsystem/store/config';
import {MinioStore} from '../../apps/execution-worker/src/raw-archive.ts';
import {channelUnavailablePage,confirmedChannelRemoval} from '../../apps/execution-worker/src/youtube/channel-removal.ts';
import {workspace,kube,object} from './finish-common.ts';
const dir='.runtime/failure-governance',id=process.argv[2],pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/crawlsystem_m1_main_test');
const reviewed=JSON.parse(readFileSync(dir+'/retry-actions.json','utf8')).items;
assert.ok(reviewed.some(i=>i.result?.retry_plan_id===id));
try {
 const rows=(await pool.query(`SELECT f.failure_id,f.raw_object,p.channel_id FROM control.failures f JOIN control.plans p USING(plan_id)
   WHERE f.workspace_id=$1 AND f.plan_id=$2 AND f.stage='WORKER' AND f.raw_object IS NOT NULL ORDER BY f.first_at`,[workspace,id])).rows;
 const credentials=object(['-n','crawler','get','secret','minio-crawl-parser']).data;
 const store=new MinioStore('http://'+kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}'])+':9000','crawl-raw',
   Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
 const results=[];
 for(const f of rows) {
  const ref=f.raw_object,bytes=await store.get(ref.key,AbortSignal.timeout(20_000));assert.ok(bytes);assert.equal(bytes.length,ref.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);
  writeFileSync(dir+'/latest-source-'+f.failure_id+'.raw.gz',bytes,{mode:0o600});
  const raw=JSON.parse(gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString()),responses=raw.responses??[];
  results.push({failure_id:f.failure_id,plan_id:id,channel_id:f.channel_id,responses:responses.map(r=>{
   let body={};try{body=JSON.parse(r.body);}catch{}
   const alerts=body.alerts?.map(a=>a.alertRenderer?.text?.simpleText??a.alertRenderer?.text?.runs?.map(t=>t.text).join('')??'')??[];
   return {path:new URL(r.endpoint).pathname,status:r.status,bytes:r.body.length,json_keys:Object.keys(body),
    metadata_title:!!body.metadata?.channelMetadataRenderer?.title,metadata_identity:body.metadata?.channelMetadataRenderer?.externalId===f.channel_id,
    alerts,api_items:Array.isArray(body.items)?body.items.length:undefined};
  }),unavailable_page:channelUnavailablePage(responses,f.channel_id),confirmed_removal:confirmedChannelRemoval(responses,f.channel_id)});
 }
 const report=JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n';
 writeFileSync(dir+'/source-diagnosis-'+id+'.json',report,{mode:0o600});
 writeFileSync(dir+'/source-diagnosis.json',report,{mode:0o600});console.log(JSON.stringify({results}));
}catch(error) {
 writeFileSync(dir+'/source-diagnosis-error.json',JSON.stringify({name:error.name,message:error.message},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error.name}));process.exitCode=1;
}finally {await pool.end();}
