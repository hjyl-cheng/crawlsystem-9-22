import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {workspace,client} from './finish-common.ts';

// One audited VIDEO replacement per already reviewed channel, through the public
// operator API. Interrupted requests replay the persisted request identity.
const dir='.runtime/failure-governance',file=dir+'/video-recovery-actions.json',pool=createPool(),mode=process.argv[2];
type Entry={channel_id:string;incomplete_ids:string[];command?:{request_id:string;expected_version:number;domains:['VIDEO']};plan_id?:string;recovery_ids?:string[];settled?:string};
type Audit={started_at:string;items:Entry[];last_run_at?:string};
let audit:Audit;
const save=()=>writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 if(mode==='prepare') {
  assert.ok(!existsSync(file),'Use the persisted recovery review');
  const reviewed=JSON.parse(readFileSync(dir+'/retry-actions.json','utf8')).items.map((i:any)=>i.channel_id);
  reviewed.push('UCIR4dFmFWfflh0Kb-LZfNrw');
  const rows=(await pool.query(`SELECT v.channel_id,array_agg(v.video_id ORDER BY v.video_id) incomplete_ids
    FROM crawl_data.videos v JOIN control.plans p ON p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id AND p.source_revision=v.source_revision
    WHERE v.workspace_id=$1 AND p.status IN ('FAILED','CANCELLED') AND v.channel_id=ANY($2::text[])
      AND EXISTS(SELECT 1 FROM control.channel_overview c WHERE c.workspace_id=v.workspace_id AND c.channel_id=v.channel_id AND c.management_state IN ('managed','paused')
        AND EXISTS(SELECT 1 FROM control.plans about WHERE about.workspace_id=c.workspace_id AND about.channel_id=c.channel_id AND about.source_revision=c.about_revision AND about.status='COMPLETED')
        AND EXISTS(SELECT 1 FROM control.plans agent WHERE agent.workspace_id=c.workspace_id AND agent.channel_id=c.channel_id AND agent.source_revision=c.agent_revision AND agent.status='COMPLETED'))
    GROUP BY v.channel_id ORDER BY count(*),v.channel_id`,[workspace,reviewed])).rows;
  assert.ok(rows.length>0&&rows.length<=15);audit={started_at:new Date().toISOString(),items:rows};save();
  console.log(JSON.stringify({reviewed_channels:rows.length,unfinished_video_observations:rows.reduce((n,r)=>n+r.incomplete_ids.length,0)}));
 }else if(mode==='apply') {
  audit=JSON.parse(readFileSync(file,'utf8'));const {api,headers}=await client(),end=Date.now()+210_000;
  while(Date.now()<end&&audit.items.some(i=>!i.plan_id&&!i.settled)) {
   for(const item of audit.items.filter(i=>!i.plan_id&&!i.settled)) {
    // Recover the result even when the client lost the admission response.
    if(item.command) {
     const prior=(await pool.query('SELECT plan_id,frozen_input FROM control.plans WHERE workspace_id=$1 AND request_id=$2',[workspace,item.command.request_id])).rows[0];
     if(prior){item.plan_id=prior.plan_id;item.recovery_ids=prior.frozen_input.recovery_video_ids;save();continue;}
    }
    const left=(await pool.query(`SELECT count(*)::int n FROM crawl_data.videos v LEFT JOIN control.plans p ON p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id AND p.source_revision=v.source_revision
      WHERE v.workspace_id=$1 AND v.channel_id=$2 AND p.status IS DISTINCT FROM 'COMPLETED'`,[workspace,item.channel_id])).rows[0].n;
    if(!left){item.settled='FINALIZED_BY_ANOTHER_PLAN';save();continue;}
    if((await pool.query("SELECT 1 FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace,item.channel_id])).rowCount)continue;
    const settings=(await pool.query('SELECT settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0].settings.update;
    const active=(await pool.query("SELECT count(*)::int n FROM control.plans WHERE workspace_id=$1 AND source_mode='youtube' AND status IN ('QUEUED','RUNNING','WAITING')",[workspace])).rows[0].n;
    if(active>=settings.max_active_plans)break;
    const channel=await api('/v1/channels/'+item.channel_id);
    if(!item.command||item.command.expected_version!==channel.management.version)item.command={request_id:randomUUID(),expected_version:channel.management.version,domains:['VIDEO']};
    save();
    const response=await fetch('http://127.0.0.1:18103/api/v1/channels/'+item.channel_id+'/update',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(item.command),signal:AbortSignal.timeout(30_000)});
    if(response.status===409)continue;assert.equal(response.status,200,'VIDEO recovery admission');
    const plan=await response.json();item.plan_id=plan.plan_id;
    const frozen=(await pool.query('SELECT frozen_input FROM control.plans WHERE plan_id=$1',[item.plan_id])).rows[0].frozen_input;
    assert.ok(frozen.recovery_video_ids?.length>0,'The deployed Control must freeze recovery targets');
    item.recovery_ids=frozen.recovery_video_ids;save();
    console.log(JSON.stringify({channel_id:item.channel_id,plan_id:item.plan_id,recovery_videos:item.recovery_ids!.length}));
   }
   if(audit.items.every(i=>i.plan_id||i.settled))break;await delay(3_000);
  }
  audit.last_run_at=new Date().toISOString();save();
  console.log(JSON.stringify({result:'PASSED',reviewed:audit.items.length,admitted:audit.items.filter(i=>i.plan_id).length,finalized_elsewhere:audit.items.filter(i=>i.settled).length,waiting:audit.items.filter(i=>!i.plan_id&&!i.settled).length}));
 }else throw new Error('Usage: recover-governance-videos prepare|apply');
}catch(error) {
 writeFileSync(dir+'/video-recovery-error.json',JSON.stringify({at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally {await pool.end();}
