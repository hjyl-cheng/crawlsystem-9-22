import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {DataApi} from '../../apps/execution-worker/src/youtube/data-api.ts';
import {workspace} from './finish-common.ts';
const dir='.runtime/failure-governance',id=process.argv[2],pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/crawlsystem_m1_main_test');
assert.ok(JSON.parse(readFileSync(dir+'/retry-actions.json','utf8')).items.some(i=>i.result?.retry_plan_id===id));
try {
 if(existsSync(dir+'/video-ownership.json')) {
  const saved=JSON.parse(readFileSync(dir+'/video-ownership.json','utf8'));
  assert.equal(saved.plan_id,id,'Review a separate diagnosis file before looking up another plan');
  console.log(JSON.stringify({...saved,reused_diagnosis:true,new_api_requests:0}));
 }else {
 const plan=(await pool.query('SELECT p.channel_id,p.status,t.manifest FROM control.plans p JOIN control.plan_video_targets t USING(plan_id) WHERE p.workspace_id=$1 AND p.plan_id=$2',[workspace,id])).rows[0];
 assert.equal(plan.status,'FAILED');const ids=plan.manifest.video_ids.slice(0,10);assert.ok(ids.length&&ids.length<=10);
 // One read-only official lookup of the failed batch; never prints its key or
 // writes collected data, changes a plan, or publishes a replacement result.
 const limits=(await pool.query('SELECT settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0].settings.update;
 const budget=(await pool.query('SELECT used_units,reserved_units FROM control.data_api_budget WHERE workspace_id=$1 ORDER BY quota_day DESC LIMIT 1',[workspace])).rows[0];
 assert.ok(Number(budget.used_units)+Number(budget.reserved_units)+1<limits.api_daily_limit);
 const api=new DataApi(readFileSync('.runtime/youtube-data-api-key','utf8').trim()),videos=await api.videos(ids);
 const result={at:new Date().toISOString(),plan_id:id,requested_channel_id:plan.channel_id,diagnostic_api_requests:api.units,
  videos:ids.map(video_id=>{const v=videos.find(v=>v.id===video_id);return {video_id,api_found:!!v,api_channel_id:v?.snippet.channelId??null,owner_matches:!!v&&v.snippet.channelId===plan.channel_id};})};
 assert.equal(api.units,1);writeFileSync(dir+'/video-ownership.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
 }
}catch(error) {
 writeFileSync(dir+'/video-ownership-error.json',JSON.stringify({name:error.name,message:error.message},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error.name}));process.exitCode=1;
}finally {await pool.end();}
