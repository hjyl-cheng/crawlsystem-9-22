import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createPool} from '@crawlsystem/store/config';
import {MinioStore} from '../../apps/execution-worker/src/raw-archive.ts';
import {ResponseReplay} from '../../apps/raw-parser/src/parser.ts';
import {uploads} from '../../apps/execution-worker/src/youtube/web-scrape.ts';
import {mergeRecoveryVideoTargets} from '@crawlsystem/contracts';
import {workspace,kube,object} from './finish-common.ts';
const dir='.runtime/failure-governance',pool=createPool(),diagnosis=JSON.parse(readFileSync(dir+'/video-ownership.json','utf8'));
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/crawlsystem_m1_main_test');
const originalFetch=globalThis.fetch;
try {
 const row=(await pool.query("SELECT u.fact->'raw' ref,t.manifest,p.frozen_input->'recovery_video_ids' recovery FROM crawl_data.ingest_units u JOIN control.plan_video_targets t USING(plan_id) JOIN control.plans p USING(plan_id) WHERE u.workspace_id=$1 AND u.plan_id=$2 AND u.step='TARGETS'",[workspace,diagnosis.plan_id])).rows[0];assert.ok(row);
 const credentials=object(['-n','crawler','get','secret','minio-crawl-parser']).data;
 const store=new MinioStore('http://'+kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}'])+':9000','crawl-raw',Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
 const bytes=await store.get(row.ref.key,AbortSignal.timeout(20_000));assert.ok(bytes);assert.equal(bytes.length,row.ref.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),row.ref.sha256);writeFileSync(dir+'/upload-sample.raw.gz',bytes,{mode:0o600});
 const unit=JSON.parse(gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString()),playlistId='UU'+diagnosis.requested_channel_id.slice(2),members=new Set();
 let declaredVideos=null;
 const walk=value=>{
  if(!value||typeof value!=='object')return;
  const header=value.playlistHeaderRenderer;
  if(header?.playlistId===playlistId)declaredVideos=Number(header.numVideosText?.runs?.[0]?.text);
  // The playlist is an artist's aggregated uploads, not a recommendation shelf.
  const node=value.lockupViewModel,watch=node?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  if(watch?.playlistId===playlistId&&watch.videoId===node.contentId)members.add(node.contentId);
  for(const child of Object.values(value))walk(child);
 };
 for(const r of unit.responses)walk(JSON.parse(r.body));
 // Every YouTube read is served from the downloaded capture from this point.
 globalThis.fetch=async()=>{throw new Error('Upload replay cannot reach the network');};
 const listed=await uploads(await new ResponseReplay(unit.responses).client(),diagnosis.requested_channel_id,30);
 assert.deepEqual(mergeRecoveryVideoTargets(listed.ids,row.recovery),row.manifest.video_ids);assert.equal(listed.ids.length,30);assert.equal(listed.exhausted,false);
 const conflicts=diagnosis.videos.filter(v=>v.api_found&&!v.owner_matches);
 assert.equal(conflicts.length,3);assert.ok(conflicts.every(v=>members.has(v.video_id)&&listed.ids.includes(v.video_id)));
 assert.ok(declaredVideos>listed.ids.length);
 const result={result:'PASSED',at:new Date().toISOString(),plan_id:diagnosis.plan_id,old_targets:row.manifest.video_ids.length,
  replayed_targets:listed.ids.length,declared_playlist_videos:declaredVideos,captured_playlist_members:members.size,
  diagnosed_videos:diagnosis.videos.length,confirmed_foreign_owners:conflicts.length,classification:'artist_playlist_ownership_conflict',
  recommendation_filter_would_not_resolve:true,offline_youtube_requests:0,production_writes:0};
 writeFileSync(dir+'/upload-replay.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}catch(error){
 writeFileSync(dir+'/upload-replay-error.json',JSON.stringify({name:error.name,message:error.message},null,2)+'\n',{mode:0o600});console.error(JSON.stringify({result:'FAILED',error:error.name}));process.exitCode=1;
}finally{globalThis.fetch=originalFetch;await pool.end();}
