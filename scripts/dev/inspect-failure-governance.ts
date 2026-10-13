import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {client,workspace} from './finish-common.ts';
const dir='.runtime/failure-governance',pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 const retries=JSON.parse(readFileSync(dir+'/retry-actions.json','utf8')).items;
 const recoveries=existsSync(dir+'/video-recovery-actions.json')?JSON.parse(readFileSync(dir+'/video-recovery-actions.json','utf8')).items:[];
 const ids=[...retries.map((i:any)=>i.result?.retry_plan_id),...recoveries.map((i:any)=>i.plan_id)].filter(Boolean);
 const plans=(await pool.query(`SELECT p.plan_id,p.channel_id,p.plan_kind,p.status,p.publication_status,p.finished_at,p.deadline_at,
   p.frozen_input->'recovery_video_ids' recovery_video_ids,p.frozen_input->'discovery_anchor_ids' anchors,
   t.manifest->'video_ids' targets,(SELECT count(*)::int FROM crawl_data.ingest_units u WHERE u.plan_id=p.plan_id AND u.step ~ '^VIDEO-[0-9]+$') video_units,
   (SELECT jsonb_agg(jsonb_build_object('status',d.status,'error_code',d.error_code)) FROM delivery.records d WHERE d.plan_id=p.plan_id) deliveries
   FROM control.plans p LEFT JOIN control.plan_video_targets t USING(plan_id) WHERE p.workspace_id=$1 AND p.plan_id=ANY($2::uuid[]) ORDER BY p.created_at`,[workspace,ids])).rows;
 const incomplete=(await pool.query(`SELECT v.channel_id,count(*)::int n,array_agg(v.video_id ORDER BY v.video_id) video_ids
   FROM crawl_data.videos v LEFT JOIN control.plans p ON p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id AND p.source_revision=v.source_revision
   WHERE v.workspace_id=$1 AND p.status IS DISTINCT FROM 'COMPLETED' GROUP BY v.channel_id ORDER BY n DESC`,[workspace])).rows;
 const active=(await pool.query("SELECT plan_id,channel_id,plan_kind,status,deadline_at FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING') ORDER BY created_at",[workspace])).rows;
 const failures=(await pool.query('SELECT state,stage,code,count(*)::int n FROM control.failures WHERE workspace_id=$1 GROUP BY state,stage,code ORDER BY state,stage,code',[workspace])).rows;
 const {api}=await client(),workers=await api('/v1/workers?limit=100'),delivery=await api('/v1/deliveries/summary');
 const snapshot={at:new Date().toISOString(),plans,incomplete,active,failures,workers,delivery};
 writeFileSync(dir+'/latest-progress.json',JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({at:snapshot.at,plans:plans.map(p=>({plan_id:p.plan_id,channel_id:p.channel_id,status:p.status,publication:p.publication_status,recovery:p.recovery_video_ids?.length??0,targets:p.targets?.length??0,video_units:p.video_units})),
  incomplete:incomplete.map(c=>({channel_id:c.channel_id,n:c.n})),active,open_failures:failures.filter(f=>['OPEN','RETRYING'].includes(f.state)),delivery}));
}catch(error){
 writeFileSync(dir+'/inspect-error.json',JSON.stringify({at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally {await pool.end();}
