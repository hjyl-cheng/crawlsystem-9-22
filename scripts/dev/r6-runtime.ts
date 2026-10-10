import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {ApiRoutes,PlanDetailSchema} from '@crawlsystem/contracts';

// Target the running R5 images: restoring scheduling requires no image rebuild or migration.
const mode=process.argv[2]??'snapshot';
assert.ok(['start','all','snapshot','verify'].includes(mode));
const directory='.runtime/r6',workspace='m1-main';
mkdirSync(directory,{recursive:true,mode:0o700});
const save=(name:string,value:unknown)=>writeFileSync(`${directory}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190_000}).trim();
const workloads=[['control','deployment','control-api-preview'],['control','deployment','intent-dispatcher'],['crawler','statefulset','execution-worker'],['crawler','deployment','raw-parser'],['ingest','deployment','pg-sink'],['analytics','deployment','crawl-analytics']] as const;
const objects=()=>workloads.map(([namespace,kind,name])=>({namespace,kind,name,object:JSON.parse(kube(['-n',namespace,'get',kind,name,'-o','json']))}));
const settings={
  QUERY_RUNS_ENABLED:'true',QUERY_AUTO_ADMIT:'true',QUERY_MAX_ACTIVE_RUNS:'2',QUERY_DAILY_RUN_LIMIT:'300',
  QUERY_MAX_PAGES:'5',QUERY_CONTINUE_MIN_NEW:'3',QUERY_MIN_SUBSCRIBERS:'1000',QUERY_API_RESERVE:'3000',
  QUERY_BACKLOG_LIMIT:'2000',QUERY_IMPORT_BUFFER:'50',UPDATE_SCHEDULER_ENABLED:'true',
  UPDATE_MAX_ACTIVE_PLANS:'2',UPDATE_MAX_AGENT_PLANS:'1',UPDATE_DAILY_PLAN_LIMIT:'100',UPDATE_API_DAILY_LIMIT:'10000',
};
const pool=createPool();
const token=await issueToken({subject:'r6-runtime-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),1800);
const base=`http://${kube(['-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}'])}:18100`;
async function api(path:string) {
  const response=await fetch(base+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  assert.ok(response.ok,`R6 read API ${path}: HTTP ${response.status}`);return response.json();
}
async function snapshot() {
  const stateFile=`${directory}/state.json`,state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{started_at:new Date().toISOString()};
  const query=async(sql:string)=>(await pool.query(sql,[workspace,state.started_at])).rows;
  const rows={
    plans:await query(`SELECT plan_kind,status,count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND created_at>=$2 GROUP BY 1,2 ORDER BY 1,2`),
    plan_details:await query(`SELECT plan_id,channel_id,plan_kind,update_trigger,status,required_domains,created_at,finished_at,frozen_input->>'pipeline_version' AS pipeline_version
      FROM control.plans WHERE workspace_id=$1 AND created_at>=$2 ORDER BY created_at`),
    searches:await query(`SELECT state,count(*)::int AS n,sum(new_channels)::int AS discovered,sum(qualified_new)::int AS qualified,sum(qualification_pending)::int AS qualification_pending
      FROM control.query_runs WHERE workspace_id=$1 AND created_at>=$2 GROUP BY state ORDER BY state`),
    search_details:await query(`SELECT run_id,state,params->>'policy_version' AS policy_version,pages,new_channels,qualified_new,qualification_pending,clock_settled_at,last_error
      FROM control.query_runs WHERE workspace_id=$1 AND created_at>=$2 ORDER BY created_at`),
    automatic_admissions:await query(`SELECT count(*)::int AS n FROM control.channel_candidates WHERE workspace_id=$1 AND decided_by='auto' AND decided_at>=$2`),
    imports:await query(`SELECT state,count(*)::int AS n FROM control.channel_imports WHERE workspace_id=$1 AND $2::timestamptz IS NOT NULL GROUP BY state ORDER BY state`),
    new_failures:await query(`SELECT stage,code,state,count(*)::int AS n FROM control.failures WHERE workspace_id=$1 AND first_at>=$2 GROUP BY 1,2,3 ORDER BY 1,2,3`),
    video_counts:await query(`SELECT count(*)::int AS videos,count(*) FILTER(WHERE data->'comments_ref' IS NOT NULL AND data->'comments_ref'<>'null'::jsonb)::int AS comment_refs,
      count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int AS comment_bodies,
      count(*) FILTER(WHERE observed_at>=$2)::int AS observations FROM crawl_data.videos WHERE workspace_id=$1`),
    outbox:await query(`SELECT count(*) FILTER(WHERE archived_at IS NULL)::int AS unarchived,min(created_at) FILTER(WHERE archived_at IS NULL) AS oldest
      FROM telemetry.outbox WHERE workspace_id=$1 AND $2::timestamptz IS NOT NULL`),
    workers:await query(`SELECT worker_id,last_heartbeat_at,heartbeat->>'accepting_work' AS accepting,heartbeat->'running_plan_ids' AS running
      FROM control.workers WHERE workspace_id=$1 AND $2::timestamptz IS NOT NULL`),
  };
  const services=objects().map(({namespace,name,object})=>({namespace,name,ready:object.status.readyReplicas??0,desired:object.spec.replicas,
    containers:object.spec.template.spec.containers.map((c:any)=>({name:c.name,image:c.image,settings:Object.fromEntries((c.env??[]).filter((e:any)=>Object.hasOwn(settings,e.name)||['UPDATE_AUTO_DOMAINS','QUERY_RUNNER_SLOTS','REQUIRED_EGRESS_COUNTRY','PIPELINE_ENABLED'].includes(e.name)).map((e:any)=>[e.name,e.value]))}))}));
  const pods=JSON.parse(kube(['get','pods','-A','-o','json'])).items.filter((p:any)=>['control','crawler','ingest','analytics'].includes(p.metadata.namespace)&&p.metadata.labels?.['app.kubernetes.io/name']&&['control-api-preview','intent-dispatcher','execution-worker','raw-parser','pg-sink','crawl-analytics'].includes(p.metadata.labels['app.kubernetes.io/name']))
    .map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,uid:p.metadata.uid,phase:p.status.phase,created_at:p.metadata.creationTimestamp,containers:(p.status.containerStatuses??[]).map((c:any)=>({name:c.name,ready:c.ready,restarts:c.restartCount,last_reason:c.lastState?.terminated?.reason??null}))}));
  const result={at:new Date().toISOString(),started_at:state.started_at,rows,services,pods,
    summaries:{queries:await api(ApiRoutes.queriesSummary),candidates:await api(ApiRoutes.candidatesSummary),updates:await api(ApiRoutes.updatesSummary),storage:await api('/v1/storage')}};
  save('latest',result);save(`snapshot-${Date.now()}`,result);
  console.log(JSON.stringify({at:result.at,rows,ready:services.every(s=>s.ready===s.desired),search_idle_reason:result.summaries.queries.runs?.idle_reason??null}));
  return result;
}
function setEnv(namespace:string,kind:string,name:string,env:Record<string,string>) {
  kube(['-n',namespace,'set','env',`${kind}/${name}`,...Object.entries(env).map(([key,value])=>`${key}=${value}`)]);
  kube(['-n',namespace,'rollout','status',`${kind}/${name}`,'--timeout=180s']);
  console.log(JSON.stringify({phase:'ready',namespace,name}));
}
try {
  if(mode==='start') {
    if(!existsSync(`${directory}/state.json`)) {
      const before=objects();assert.ok(before.every(x=>(x.object.status.readyReplicas??0)===x.object.spec.replicas),'All pipeline workloads must be ready');
      assert.equal((await pool.query('SELECT max(version) AS version FROM m1.migrations')).rows[0].version,29);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace])).rows[0].n,0,'Do not restart an active collector');
      const worker=before.find(x=>x.name==='execution-worker')!.object.spec.template.spec.containers.find((c:any)=>c.name==='worker');
      assert.equal((worker.env??[]).find((e:any)=>e.name==='REQUIRED_EGRESS_COUNTRY')?.value??'','');
      save('previous-workloads',before);
      save('preservation-before',(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows);
      save('state',{started_at:new Date().toISOString(),backend_image:worker.image,phase:'prepared'});
    }
    const state=JSON.parse(readFileSync(`${directory}/state.json`,'utf8'));
    if(state.phase!=='prepared')throw new Error('R6 already started; use snapshot/all/verify, do not restart active collection');
    // Let the existing qualified/import backlog produce a few full collections first.
    // All three clocks are restored by the separate `all` step after that evidence exists.
    setEnv('crawler','statefulset','execution-worker',{QUERY_RUNNER_SLOTS:'2'});
    setEnv('control','deployment','control-api-preview',{...settings,UPDATE_AUTO_DOMAINS:'VIDEO,AGENT'});
    setEnv('control','deployment','intent-dispatcher',{...settings,UPDATE_AUTO_DOMAINS:'VIDEO,AGENT'});
    state.phase='first-collections';state.enabled_at=new Date().toISOString();save('state',state);await snapshot();
  } else if(mode==='all') {
    const state=JSON.parse(readFileSync(`${directory}/state.json`,'utf8'));
    assert.ok(['first-collections','all-clocks'].includes(state.phase));
    const completed=(await pool.query("SELECT count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND created_at>=$2 AND plan_kind='FULL' AND status='COMPLETED'",[workspace,state.started_at])).rows[0].n;
    assert.ok(completed>=2,'Observe at least two automatic full collections before restoring all due clocks');
    setEnv('control','deployment','control-api-preview',{UPDATE_AUTO_DOMAINS:'ABOUT,VIDEO,AGENT'});
    setEnv('control','deployment','intent-dispatcher',{UPDATE_AUTO_DOMAINS:'ABOUT,VIDEO,AGENT'});
    state.phase='all-clocks';state.all_clocks_at=new Date().toISOString();save('state',state);await snapshot();
  } else {
    const result=await snapshot();
    if(mode==='verify') {
      const count=(kind:string,status:string)=>result.rows.plans.find(r=>r.plan_kind===kind&&r.status===status)?.n??0;
      assert.ok(count('FULL','COMPLETED')>=3,'At least three automatic full collections');
      assert.ok(count('UPDATE','COMPLETED')>=2,'At least two scheduled updates');
      assert.ok(result.rows.searches.some(r=>r.state==='SUCCEEDED'&&r.n>=2),'At least two automatic searches');
      assert.ok(result.rows.automatic_admissions[0]!.n>=2);
      assert.ok(result.rows.video_counts[0]!.observations>0);assert.equal(result.rows.video_counts[0]!.comment_bodies,0);
      assert.ok(result.summaries.storage.clickhouse.available);assert.ok(result.rows.outbox[0]!.unarchived<100,'No sustained archive backlog');
      assert.ok(result.services.every(s=>s.ready===s.desired));
      for(const service of result.services.filter(s=>s.namespace==='control'))for(const container of service.containers) {
        for(const [key,value] of Object.entries(settings))assert.equal(container.settings[key],value);
        assert.equal(container.settings.UPDATE_AUTO_DOMAINS,'ABOUT,VIDEO,AGENT');assert.equal(container.settings.PIPELINE_ENABLED,'true');
      }
      const worker=result.services.find(s=>s.name==='execution-worker')!.containers.find((c:any)=>c.name==='worker');
      assert.equal(worker.settings.QUERY_RUNNER_SLOTS,'2');assert.equal(worker.settings.REQUIRED_EGRESS_COUNTRY??'','');
      const before=JSON.parse(readFileSync(`${directory}/preservation-before.json`,'utf8')) as {workspace_id:string;channel_id:string;video_id:string}[];
      const current=(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows;
      const identities=new Set(current.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id])));
      assert.ok(before.every(r=>identities.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))),'Every existing video identity is preserved');
      for(const plan of result.rows.plan_details.filter(r=>r.status==='COMPLETED'&&r.plan_kind==='FULL')) {
        const detail=PlanDetailSchema.parse(await api(`/v1/plans/${plan.plan_id}`));
        assert.equal(detail.input.source_mode,'youtube');assert.ok(detail.input.source_mode==='youtube'&&detail.input.pipeline_version==='r3.v1');
        assert.ok(detail.domains.every(d=>d.state==='APPLIED'));
      }
      const evidence={result:'PASSED',...result,preserved_video_identities:before.length};save('final-evidence',evidence);
      console.log(JSON.stringify({result:'PASSED',full_completed:count('FULL','COMPLETED'),updates_completed:count('UPDATE','COMPLETED'),preserved_video_identities:before.length}));
    }
  }
}finally{await pool.end();}
