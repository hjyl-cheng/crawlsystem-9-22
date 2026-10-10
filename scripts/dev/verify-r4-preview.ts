import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {upsertBindings} from '@crawlsystem/store/discovery';
import {QueryRunParamsSchema,PlanDetailSchema,PlanSchema,type QueryRunClaim} from '@crawlsystem/contracts';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {MinioStore} from '../../apps/execution-worker/src/raw-archive.ts';
import {gunzipSync} from 'node:zlib';

const mode=process.argv[2]??'full';assert.ok(['full','reject'].includes(mode));
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:330000}).trim();
for(const [ns,kind,name,flag,value] of [['control','deployment','control-api-preview','QUERY_RUNS_ENABLED','false'],['control','deployment','control-api-preview','QUERY_AUTO_ADMIT','false'],['control','deployment','intent-dispatcher','UPDATE_SCHEDULER_ENABLED','false'],['crawler','statefulset','execution-worker','QUERY_RUNNER_SLOTS','0']])
  assert.equal(kube(['-n',ns!,'get',kind!,name!,'-o',`jsonpath={.spec.template.spec.containers[0].env[?(@.name=="${flag}")].value}`]),value);
const worker='execution-worker-0',workspace='m1-main',pool=createPool();
const base=`http://${kube(['-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}'])}:18100`;
const token=await issueToken({subject:'r4-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),1800);
const api=async(path:string,body?:unknown)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});assert.ok(r.ok,`Acceptance HTTP ${r.status}`);return r.json();};
mkdirSync('.runtime/r4',{recursive:true,mode:0o700});
const file=`.runtime/r4/${mode}-state.json`;
let state:any=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
const save=()=>writeFileSync(file,JSON.stringify(state,null,2),{mode:0o600});
try {
  if(!state.run_id) {
    const text=mode==='full'?'Google Developers tutorials':'programação para iniciantes';
    await upsertBindings(pool,workspace,[{text,country:'BR',language:'pt',category:'Tech',source_type:'MANUAL',source_ref:'r4-bounded-acceptance'}]);
    const binding=(await pool.query('SELECT b.binding_id FROM control.query_bindings b JOIN control.query_terms t USING(term_id) WHERE b.workspace_id=$1 AND t.text=lower($2) AND b.country=\'BR\' AND b.category=\'Tech\'',[workspace,text])).rows[0];
    assert.ok(binding);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control.query_runs WHERE binding_id=$1 AND (state IN ('PENDING','RUNNING') OR state='SUCCEEDED' AND clock_settled_at IS NULL)",[binding.binding_id])).rows[0].n,0,'Do not take over an existing run');
    const params=QueryRunParamsSchema.parse({text,country:'BR',language:'pt',category:'Tech',window:'THIS_YEAR',sort:'popularity',max_pages:1,continue_min_new:3,min_subscribers:mode==='full'?1000:100000000,policy_version:'query-clock-2-about'});
    const run_id=randomUUID(),lease=new Date(Date.now()+5*60000).toISOString();
    const claim:QueryRunClaim={run:{run_id,binding_id:binding.binding_id,attempt:1,lease_expires_at:lease,params},idle_reason:null,retry_after_ms:0};
    await pool.query(`INSERT INTO control.query_runs(run_id,workspace_id,binding_id,params,state,attempt,worker_id,lease_expires_at,started_at) VALUES($1,$2,$3,$4,'RUNNING',1,$5,$6,clock_timestamp())`,[run_id,workspace,binding.binding_id,params,worker,lease]);
    state={run_id,claim};save();
  }
  let run=(await pool.query('SELECT * FROM control.query_runs WHERE run_id=$1',[state.run_id])).rows[0];
  if(run.state!=='SUCCEEDED') {
    if(run.state==='PENDING') {
      assert.ok(run.attempt<3,'Bounded acceptance exhausted its attempts');
      const lease=new Date(Date.now()+5*60000).toISOString();
      await pool.query("UPDATE control.query_runs SET state='RUNNING',attempt=attempt+1,worker_id=$2,lease_expires_at=$3,retry_at=NULL WHERE run_id=$1",[state.run_id,worker,lease]);
      state.claim.run.attempt=run.attempt+1;state.claim.run.lease_expires_at=lease;save();
    }
    const claimFile=`.runtime/r4/${mode}-claim.json`;writeFileSync(claimFile,JSON.stringify(state.claim),{mode:0o600});
    kube(['-n','crawler','cp',claimFile,`${worker}:/tmp/r4-${mode}-claim.json`,'-c','worker']);
    console.log(kube(['-n','crawler','exec',worker,'-c','worker','--','node','/app/worker/src/query-once.mjs',`/tmp/r4-${mode}-claim.json`]));
    run=(await pool.query('SELECT * FROM control.query_runs WHERE run_id=$1',[state.run_id])).rows[0];
  }
  assert.equal(run.state,'SUCCEEDED','Resume the saved bounded run after correcting any search failure');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM control.data_api_permits WHERE run_id=$1',[state.run_id])).rows[0].n,0);
  const pages=(await pool.query('SELECT raw_reference FROM control.query_run_pages WHERE run_id=$1 ORDER BY attempt DESC,page',[state.run_id])).rows;
  assert.ok(pages.length);
  const credentials=JSON.parse(kube(['-n','crawler','get','secret','minio-crawl-parser','-o','json'])).data;
  const objects=new MinioStore(`http://${kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}'])}:9000`,'crawl-raw',Buffer.from(credentials.access_key,'base64').toString(),Buffer.from(credentials.secret_key,'base64').toString());
  for(const page of pages) {
    const ref=page.raw_reference,bytes=await objects.get(ref.key,AbortSignal.timeout(20000));assert.ok(bytes);assert.equal(bytes.length,ref.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);
    const raw=JSON.parse(gunzipSync(bytes).toString());assert.ok(raw.responses.some((r:any)=>r.endpoint.startsWith('https://www.youtube.com/results')));
  }
  let candidates=(await pool.query('SELECT channel_id,state,version FROM control.channel_candidates WHERE first_run_id=$1 ORDER BY channel_id',[state.run_id])).rows;
  assert.ok(candidates.length,'Search should discover at least one new channel');
  if(!state.channel_id) {state.channel_id=candidates[0].channel_id;save();}
  for(const c of candidates.filter(c=>c.channel_id!==state.channel_id && c.state==='DISCOVERED')) await api(`/v1/candidates/${c.channel_id}`,{action:'reject',reason:'R4 小样本验收：本次仅准入一个频道',expected_version:c.version});
  if(!state.plan_id) {
    const c=(await pool.query('SELECT state,version FROM control.channel_candidates WHERE workspace_id=$1 AND channel_id=$2',[workspace,state.channel_id])).rows[0];
    if(c.state==='DISCOVERED') await api(`/v1/candidates/${state.channel_id}`,{action:'admit',expected_version:c.version});
    const plan=PlanSchema.parse(await api('/v1/plans',{request_id:randomUUID(),source_mode:'youtube',channel_id:state.channel_id,required_domains:['ABOUT','VIDEO','AGENT'],scope:{video_limit:2,comments_per_video:5}}));
    state.plan_id=plan.plan_id;save();
  }
  console.log(JSON.stringify({phase:'plan',mode,run_id:state.run_id,plan_id:state.plan_id,channel_id:state.channel_id}));
  let final;
  for(const end=Date.now()+15*60000;Date.now()<end;await delay(10000)) {
    const detail=PlanDetailSchema.parse(await api(`/v1/plans/${state.plan_id}`));
    assert.equal(detail.input.source_mode,'youtube');if(detail.input.source_mode!=='youtube')throw new Error('Unexpected source');
    assert.equal(detail.input.pipeline_version,'r3.v1');assert.equal(detail.input.discovery_qualification?.min_subscribers,mode==='full'?1000:100000000);
    console.log(JSON.stringify({phase:'progress',mode,status:detail.plan.status,domains:detail.domains.map(d=>`${d.domain}:${d.state}`)}));
    assert.notEqual(detail.plan.status,'FAILED');
    if(!['COMPLETED','CANCELLED'].includes(detail.plan.status))continue;
    assert.equal(detail.plan.status,mode==='full'?'COMPLETED':'CANCELLED');final=detail;break;
  }
  assert.ok(final,'Resume with the saved plan, without creating another');
  const ledger=(await pool.query('SELECT step FROM crawl_data.ingest_units WHERE plan_id=$1 ORDER BY step',[state.plan_id])).rows;
  const gate=(await pool.query('SELECT passed,subscriber_count,reason FROM control.plan_qualifications WHERE plan_id=$1',[state.plan_id])).rows[0];
  assert.equal(gate.passed,mode==='full');
  if(mode==='reject') {assert.deepEqual(ledger,[{step:'ABOUT'}]);assert.equal(final.video_targets,undefined);}
  else assert.ok(ledger.some(r=>r.step==='AGENT'));
  const after=(await pool.query('SELECT qualified_new,qualification_pending,clock_settled_at FROM control.query_runs WHERE run_id=$1',[state.run_id])).rows[0];
  assert.equal(after.qualification_pending,0);assert.ok(after.clock_settled_at);assert.equal(after.qualified_new,mode==='full'?1:0);
  const evidence={result:'PASSED',mode,run_id:state.run_id,plan_id:state.plan_id,channel_id:state.channel_id,new_candidates:candidates.length,verified_search_pages:pages.length,search_data_api_calls:0,gate,durable_steps:ledger.map(r=>r.step),clock:after,automatic_search:false,automatic_admission:false,automatic_updates:false,verified_at:new Date().toISOString()};
  writeFileSync(`.runtime/r4/${mode}-evidence.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
} finally {await pool.end();}
