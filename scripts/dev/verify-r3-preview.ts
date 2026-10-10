import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { ChannelDetailSchema,PlanDetailSchema,PlanSchema,CommentPageSchema } from '@crawlsystem/contracts';
import { PipelineFactSchema,PipelineProgressSchema,StepManifestSchema } from '@crawlsystem/contracts/pipeline';
import { contentHash } from '@crawlsystem/contracts/hash';
import { createPool } from '@crawlsystem/store/config';
import { issueToken,loadSigningKey } from '@crawlsystem/http/auth';
import { MinioStore } from '../../apps/execution-worker/src/raw-archive.ts';
const kube=(...args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const mode=process.argv[2]??'full';assert.ok(['full','update'].includes(mode));
const base=`http://${kube('-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}')}:18100`;
const token=await issueToken({subject:'r3-acceptance',workspace_id:'m1-main',role:'operator'},loadSigningKey(),1800);
const api=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});assert.ok(response.ok,`Acceptance HTTP ${response.status}`);return response.json();};
for(const [ns,name,flag] of [['control','control-api-preview','QUERY_RUNS_ENABLED'],['control','control-api-preview','QUERY_AUTO_ADMIT'],['control','intent-dispatcher','UPDATE_SCHEDULER_ENABLED']])
  assert.equal(kube('-n',ns!,'get','deployment',name!,'-o',`jsonpath={.spec.template.spec.containers[0].env[?(@.name=="${flag}")].value}`),'false');
const channelId='UC_x5XG1OV2P6uZZ5FSM9Ttw',before=ChannelDetailSchema.parse(await api(`/v1/channels/${channelId}`));
const id=process.argv[3]??PlanSchema.parse(await api(mode==='full'?'/v1/plans':`/v1/channels/${channelId}/update`,mode==='full'
  ?{request_id:randomUUID(),source_mode:'youtube',channel_id:channelId,required_domains:['ABOUT','VIDEO','AGENT'],scope:{video_limit:2,comments_per_video:5}}
  :{request_id:randomUUID(),expected_version:before.management.version,domains:['VIDEO']})).plan_id;
mkdirSync('.runtime/r3',{recursive:true,mode:0o700});writeFileSync(`.runtime/r3/${mode}-plan`,id);console.log(JSON.stringify({phase:'created',mode,plan_id:id}));
const pool=createPool();
try {
  let completed=false;
  for(const end=Date.now()+20*60000;Date.now()<end;await delay(10000)) {
    const detail=PlanDetailSchema.parse(await api(`/v1/plans/${id}`));
    console.log(JSON.stringify({phase:'progress',status:detail.plan.status,domains:detail.domains.map(d=>`${d.domain}:${d.state}`),last_phase:detail.events[0]?.phase}));
    assert.equal(detail.input.pipeline_version,'r3.v1');assert.ok(!['FAILED','CANCELLED'].includes(detail.plan.status));
    if(detail.plan.status!=='COMPLETED')continue;
    const progress=PipelineProgressSchema.parse(await api(`/v1/plans/${id}/pipeline`));assert.ok(progress.steps.every(s=>s.state==='APPLIED'&&s.applied===s.expected));
    const rows=(await pool.query('SELECT fact FROM crawl_data.ingest_units WHERE plan_id=$1 ORDER BY step,unit_id',[id])).rows;
    const credentials=JSON.parse(kube('-n','crawler','get','secret','minio-crawl-parser','-o','json')).data;
    const endpoint=`http://${kube('-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}')}:9000`;
    const objects=(bucket:string)=>new MinioStore(endpoint,bucket,Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
    const manifests=(await pool.query('SELECT manifest FROM control.pipeline_steps WHERE plan_id=$1',[id])).rows;
    assert.equal(manifests.length,progress.steps.length);
    const manifestIdentity=(m:ReturnType<typeof StepManifestSchema.parse>)=>({owner:m.owner,channel_id:m.channel_id,step:m.step,units:m.units});
    for(const row of manifests) {
      const manifest=StepManifestSchema.parse(row.manifest),bytes=await objects('crawl-raw').get(manifest.key,AbortSignal.timeout(20000));assert.ok(bytes);
      const stored=StepManifestSchema.parse({...JSON.parse(gunzipSync(bytes).toString()),bucket:manifest.bucket,key:manifest.key});
      assert.equal(contentHash(manifestIdentity(stored)),contentHash(manifestIdentity(manifest)));
    }
    let commentObjects=0;
    for(const row of rows) {
      const fact=PipelineFactSchema.parse(row.fact);
      for(const ref of [fact.raw,fact.parsed]) {const bytes=await objects(ref.bucket).get(ref.key,AbortSignal.timeout(20000));assert.ok(bytes);assert.equal(bytes.length,ref.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);}
      if(fact.kind==='VIDEO'&&!('unavailable' in fact.payload)) {
        assert.equal(fact.payload.comments_first_page,null);
        if(fact.payload.comments_ref){const ref=fact.payload.comments_ref,bytes=await objects(ref.bucket).get(ref.key,AbortSignal.timeout(20000));assert.ok(bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);
          const page=CommentPageSchema.parse(JSON.parse(gunzipSync(bytes).toString()));assert.equal(page.returned_count,fact.payload.comments_summary?.returned_count);commentObjects++;}
      }
    }
    const channel=ChannelDetailSchema.parse(await api(`/v1/channels/${channelId}`));
    if(mode==='full') {assert.equal(detail.video_targets?.length,2);assert.ok(channel.agent);assert.equal(channel.about?.source,'youtubei:channel_about');assert.equal(rows.length,5);}
    else {assert.deepEqual(detail.video_targets,[]);assert.deepEqual(channel.videos.map(v=>v.source_content_id).sort(),before.videos.map(v=>v.source_content_id).sort());}
    const comments=await Promise.all((detail.video_targets??[]).map(async video=>{const page=await api(`/v1/channels/${channelId}/videos/${video}/comments`);return {video_id:video,state:page.state,returned_count:page.page?.returned_count??null,total_count:page.page?.total_count??null};}));
    const result={result:'PASSED',mode,plan_id:id,verified_at:new Date().toISOString(),pipeline:detail.input.pipeline_version,targets:detail.video_targets,steps:progress.steps,durable_units:rows.length,verified_manifests:manifests.length,comment_objects:commentObjects,comments,
      automatic_search:false,automatic_admission:false,automatic_updates:false};
    writeFileSync(`.runtime/r3/${mode}-evidence.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));completed=true;break;
  }
  assert.ok(completed,'Resume the bounded acceptance using the saved plan ID');
}finally{await pool.end();}
