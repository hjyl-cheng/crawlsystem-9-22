import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {client,workspace} from './finish-common.ts';

// Only stop a new execution of the already reviewed artist ownership conflict.
// The original failures and collected units remain; never mutate their status.
const dir='.runtime/failure-governance',planId=process.argv[2],pool=createPool();
assert.match(planId??'',/^[a-f0-9-]{36}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/crawlsystem_m1_main_test');
const file=dir+'/stopped-conflict-'+planId+'.json';
try {
 const diagnosis=JSON.parse(readFileSync(dir+'/video-ownership.json','utf8'));
 const reviewed=JSON.parse(readFileSync(dir+'/retry-actions.json','utf8')).items;
 assert.ok(reviewed.some(i=>i.result?.retry_plan_id===diagnosis.plan_id));
 const conflicts=diagnosis.videos.filter(v=>v.api_found&&!v.owner_matches);
 assert.ok(conflicts.length);
 const row=(await pool.query(`SELECT p.channel_id,p.status,p.created_at,t.manifest,
   (SELECT count(*)::int FROM control.failures f WHERE f.plan_id=p.plan_id AND f.stage='WORKER' AND f.code='UNAVAILABLE') failed_attempts
   FROM control.plans p JOIN control.plan_video_targets t USING(plan_id) WHERE p.workspace_id=$1 AND p.plan_id=$2`,[workspace,planId])).rows[0];
 assert.ok(row);assert.equal(row.channel_id,diagnosis.requested_channel_id);assert.notEqual(planId,diagnosis.plan_id);
 assert.ok(new Date(row.created_at)>new Date(diagnosis.at));
 assert.ok(row.failed_attempts>0);assert.ok(conflicts.every(v=>row.manifest.video_ids.includes(v.video_id)));
 const {api}=await client(),detail=await api('/v1/plans/'+planId);
 const audit=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{plan_id:planId,channel_id:row.channel_id,
   reason:'Stop redundant in-flight retries after the reviewed artist playlist ownership conflict; preserve failed attempts and collected units.',
   diagnosed_plan_id:diagnosis.plan_id,confirmed_conflicting_video_ids:conflicts.map(v=>v.video_id),
   command:{command_id:randomUUID(),expected_version:detail.plan.version}};
 const save=()=>writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
 save();
 if(['QUEUED','RUNNING','WAITING'].includes(detail.plan.status)) {
  const result=await api('/v1/plans/'+planId+'/cancel',audit.command);
  assert.equal(result.status,'CANCELLED');audit.result=result.status;
 }else audit.result=detail.plan.status;
 audit.at=new Date().toISOString();save();
 console.log(JSON.stringify({plan_id:planId,result:audit.result,preserved_evidence:true,new_youtube_requests:0}));
}catch(error) {
 console.error(JSON.stringify({result:'FAILED',error:error.name}));process.exitCode=1;
}finally {await pool.end();}
