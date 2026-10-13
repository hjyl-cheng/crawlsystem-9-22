import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {workspace,client} from './finish-common.ts';

// Close historical generations only after a real finalized replacement is
// delivered. FAILED executions and their archived evidence remain unchanged.
const dir='.runtime/failure-governance',file=dir+'/recovered-close-actions.json',pool=createPool(),mode=process.argv[2];
const reviewed=JSON.parse(readFileSync(dir+'/before.json','utf8')).rows.map((f:any)=>f.failure_id);
const proof=async()=> (await pool.query(`SELECT f.failure_id,f.plan_id,f.channel_id,f.stage,f.code,f.unit_id,latest.plan_id delivered_plan_id,
   replacement.plan_id repeated_plan_id,recovered.plan_id recovered_unit_plan_id
 FROM control.failures f JOIN control.plans old ON old.plan_id=f.plan_id
 JOIN control.channels c ON c.workspace_id=f.workspace_id AND c.channel_id=f.channel_id
 JOIN control.plans latest ON latest.plan_id=c.latest_plan_id
 JOIN crawl_data.channels observed ON observed.workspace_id=f.workspace_id AND observed.channel_id=f.channel_id
 LEFT JOIN LATERAL(SELECT p.plan_id FROM control.plans p WHERE p.workspace_id=f.workspace_id AND p.channel_id=f.channel_id
   AND p.created_at>old.created_at AND p.status='COMPLETED' AND old.required_domains<@p.required_domains
   AND NOT EXISTS(SELECT 1 FROM unnest(old.required_domains) AS required(domain) WHERE NOT EXISTS(SELECT 1 FROM control.domains d WHERE d.plan_id=p.plan_id AND d.domain=required.domain AND d.state='APPLIED'))
   ORDER BY p.created_at DESC LIMIT 1) replacement ON true
 LEFT JOIN LATERAL(SELECT p.plan_id FROM crawl_data.videos v JOIN control.plans p ON p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id AND p.source_revision=v.source_revision
   WHERE f.stage='PARSER' AND f.step ~ '^VIDEO-[0-9]+$' AND v.workspace_id=f.workspace_id AND v.channel_id=f.channel_id AND v.video_id=f.unit_id
     AND p.status='COMPLETED' AND p.created_at>old.created_at AND v.observed_at>=(f.raw->>'captured_at')::timestamptz
     AND EXISTS(SELECT 1 FROM crawl_data.ingest_units u WHERE u.plan_id=p.plan_id AND u.unit_id=f.unit_id AND u.step ~ '^VIDEO-[0-9]+$') LIMIT 1) recovered ON true
 WHERE f.workspace_id=$1 AND f.failure_id=ANY($2::uuid[]) AND f.state='OPEN' AND f.code IN ('UNAVAILABLE','BUDGET_EXHAUSTED','REPLAY_INCOMPLETE')
   AND old.status IN ('FAILED','CANCELLED') AND latest.status='COMPLETED' AND latest.publication_status IN ('DELIVERED','UNCHANGED')
   AND EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=f.workspace_id AND p.channel_id=f.channel_id AND p.source_revision=observed.about_revision AND p.status='COMPLETED')
   AND EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=f.workspace_id AND p.channel_id=f.channel_id AND p.source_revision=observed.agent_revision AND p.status='COMPLETED')
   AND NOT EXISTS(SELECT 1 FROM crawl_data.videos v LEFT JOIN control.plans p ON p.workspace_id=v.workspace_id AND p.channel_id=v.channel_id AND p.source_revision=v.source_revision
     WHERE v.workspace_id=f.workspace_id AND v.channel_id=f.channel_id AND p.status IS DISTINCT FROM 'COMPLETED')
   AND (f.stage='PARSER' AND recovered.plan_id IS NOT NULL OR f.stage='WORKER' AND replacement.plan_id IS NOT NULL)
 ORDER BY f.channel_id,f.failure_id`,[workspace,reviewed])).rows;
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 if(mode==='prepare') {
  const eligible=await proof();writeFileSync(dir+'/recovered-close-candidates.json',JSON.stringify({at:new Date().toISOString(),items:eligible},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({eligible_historical_failures:eligible.length,stages:eligible.reduce((counts,r)=>({...counts,[r.stage]:(counts[r.stage]??0)+1}),{} as Record<string,number>)}));
 }else if(mode==='apply') {
  const audit=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{started_at:new Date().toISOString(),actions:[]};
  const save=()=>writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600}),{api}=await client();
  for(const candidate of JSON.parse(readFileSync(dir+'/recovered-close-candidates.json','utf8')).items) {
   if(audit.actions.some((a:any)=>a.failure_id===candidate.failure_id&&a.result==='IGNORED'))continue;
   const checked=(await proof()).find(r=>r.failure_id===candidate.failure_id);if(!checked)continue;
   const current=await api('/v1/failures/'+candidate.failure_id);if(current.state!=='OPEN')continue;
   const action={...checked,command:{command_id:randomUUID(),expected_version:current.version,action:'ignore',
    reason:`运营治理：后续任务 ${checked.recovered_unit_plan_id??checked.repeated_plan_id} 已完成重新采集并入库，频道交付任务 ${checked.delivered_plan_id} 已完成业务交付；关闭旧失败代次，保留原失败计划与证据。`},result:'PENDING'};
   audit.actions.push(action);save();
   const result=await api('/v1/failures/'+candidate.failure_id+'/commands',action.command);assert.equal(result.state,'IGNORED');
   action.result=result.state;save();
  }
  audit.finished_at=new Date().toISOString();save();console.log(JSON.stringify({closed_historical_failures:audit.actions.filter((a:any)=>a.result==='IGNORED').length}));
 }else throw new Error('Usage: close-recovered-governance prepare|apply');
}catch(error) {
 writeFileSync(dir+'/recovered-close-error.json',JSON.stringify({at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally {await pool.end();}
