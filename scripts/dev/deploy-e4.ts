import assert from 'node:assert/strict';
import {existsSync,readFileSync,createReadStream} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {dir,workspace,setName,claimName,kube,object,save,load,apiClient} from './e4-common.ts';

// Independent StatefulSet/PVC: the original local-path volume is pinned to s2.
// Never scale or patch the resident Worker to place a second Pod on that volume.
const mode=process.argv[2];assert.ok(['prepare','detach','activate','deploy'].includes(mode??''));
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const pool=createPool();
try{
 const {api}=await apiClient();
 if(mode==='prepare'){
  assert.ok(!existsSync(dir+'/deployment-plan.json'),'Review/resume the existing E4 plan');
  const original=object(['-n','crawler','get','statefulset','execution-worker']);
  assert.equal(original.spec.replicas,1);assert.equal(original.status.readyReplicas,1);
  const pods=object(['-n','crawler','get','pods','-l','app.kubernetes.io/name=execution-worker']).items;
  assert.equal(pods.length,1);assert.equal(pods[0].spec.nodeName,'s2');
  const node=object(['get','node','s3']);assert.ok(node.status.conditions.some((c:any)=>c.type==='Ready'&&c.status==='True'));
  assert.ok(!node.spec.unschedulable);assert.ok(node.status.conditions.every((c:any)=>!c.type.endsWith('Pressure')||c.status==='False'));
  const proxyService=object(['-n','crawler','get','service','proxy-manager']);assert.equal(proxyService.spec.internalTrafficPolicy,'Local');
  save('previous-execution-worker',original,true);
  const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];assert.equal(settings.version,5);
  const spec=structuredClone(original.spec);spec.replicas=1;spec.selector.matchLabels={'app.kubernetes.io/name':'execution-worker','app.kubernetes.io/instance':setName};
  spec.template.metadata={labels:spec.selector.matchLabels};spec.template.spec.nodeSelector={'kubernetes.io/hostname':'s3'};
  delete spec.template.spec.affinity;delete spec.template.spec.nodeName;
  const worker=spec.template.spec.containers.find((c:any)=>c.name==='worker');assert.ok(worker);
  for(const [name,value] of [['WORKER_CAPACITY','1'],['QUERY_RUNNER_SLOTS','1']]){const env=worker.env.find((e:any)=>e.name===name);assert.ok(env);env.value=value;}
  assert.equal(spec.template.spec.serviceAccountName,'execution-worker');
  assert.ok(!worker.env.some((e:any)=>/DATABASE_URL|JWT_SECRET/.test(e.name)));
  const volume=spec.template.spec.volumes.find((v:any)=>v.name==='browser-state');assert.equal(volume.persistentVolumeClaim.claimName,'execution-browser-state');volume.persistentVolumeClaim.claimName=claimName;
  const resources={apiVersion:'v1',kind:'List',items:[
   {apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:{name:claimName,namespace:'crawler',labels:{'app.kubernetes.io/instance':setName}},spec:{accessModes:['ReadWriteOnce'],storageClassName:'local-path',resources:{requests:{storage:'256Mi'}}}},
   {apiVersion:'apps/v1',kind:'StatefulSet',metadata:{name:setName,namespace:'crawler',labels:spec.selector.matchLabels},spec},
  ]};
  const proxies=(await pool.query(`SELECT p.proxy_id,p.version,p.server_id,p.generation,p.lease_expires_at,p.source_id FROM control.proxies p
   JOIN control.proxy_observations o USING(workspace_id,proxy_id) JOIN control.proxy_sources s USING(workspace_id,source_id)
   WHERE p.workspace_id=$1 AND p.enabled AND p.retired_at IS NULL AND p.server_id='s2' AND s.enabled
   AND o.server_id=p.server_id AND o.generation=p.generation AND o.state='healthy' AND o.reported_at>clock_timestamp()-interval '90 seconds'
   AND s.name IN ('MetaFetch 公共节点','CTP 9002 节点') ORDER BY o.last_success_at DESC,p.proxy_id LIMIT 12`,[workspace])).rows;
  assert.equal(proxies.length,12,'Need twelve recently healthy endpoints; retain the rest on s2');
  const remaining=(await pool.query("SELECT count(*)::int n FROM control.proxies WHERE workspace_id=$1 AND enabled AND server_id='s2'",[workspace])).rows[0].n;assert.ok(remaining-proxies.length>=30);
  const sources=(await pool.query('SELECT source_id,name,version,server_ids FROM control.proxy_sources WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])',[workspace,[...new Set(proxies.map(p=>p.source_id))]])).rows;
  const image=worker.image,build=JSON.parse(readFileSync('.runtime/d2/latest-images.json','utf8'));assert.equal(build.worker.image,image);
  assert.ok(existsSync(build.worker.tarball));
  const remote=execFileSync('ssh',['crawl-s3','sudo -n k3s ctr -n k8s.io images list -q'],{encoding:'utf8',timeout:30000}).trim().split('\n');
  for(const c of spec.template.spec.containers.filter((c:any)=>c.name!=='worker'))assert.ok(remote.includes(c.image),'The target must have the verified sidecar image');
  save('deployment-plan',{at:new Date().toISOString(),original_uid:pods[0].metadata.uid,original_spec_hash:createHash('sha256').update(JSON.stringify(original.spec)).digest('hex'),resources,proxies,sources,settings,image,tarball:build.worker.tarball},true);
  console.log(JSON.stringify({phase:'prepared',target:'s3',worker_capacity:1,query_slots:1,transfer_proxies:proxies.length,remaining_on_s2:remaining-proxies.length,images:spec.template.spec.containers.map((c:any)=>c.image)}));
 }else if(mode==='detach'){
  const plan=load('deployment-plan');assert.ok(existsSync(dir+'/runtime-before.json'),'Capture runtime before changing assignments');
  const state=existsSync(dir+'/handoff.json')?load('handoff'):{detached:[],activated:[],sources:[],not_before:null};
  for(const p of plan.proxies){
   if(state.detached.includes(p.proxy_id))continue;
   // Write the conservative deadline BEFORE the API call. A crash/lost response
   // must never erase the old lease horizon. Sync renewals are capped at 300s.
   state.not_before=new Date(Math.max(Date.parse(state.not_before??'1970-01-01'),Date.now()+330000)).toISOString();save('handoff',state);
   const current=(await pool.query('SELECT enabled,server_id,version FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2',[workspace,p.proxy_id])).rows[0];assert.ok(current);
   if(current.enabled){assert.equal(current.server_id,'s2');assert.equal(current.version,p.version);await api('/v1/proxies/'+p.proxy_id,{expected_version:current.version,enabled:false,server_id:null});}
   else assert.equal(current.server_id,null,'Only adopt this recorded detached endpoint');
   state.detached.push(p.proxy_id);save('handoff',state);
  }
  console.log(JSON.stringify({phase:'detached',count:state.detached.length,activate_after:state.not_before}));
 }else if(mode==='activate'){
  const plan=load('deployment-plan'),state=load('handoff');assert.equal(state.detached.length,plan.proxies.length);
  assert.ok(Date.now()>=Date.parse(state.not_before),'Wait for old lease expiry plus the network grace period');
  for(const p of plan.proxies){
   if(state.activated.includes(p.proxy_id))continue;
   const current=(await pool.query('SELECT enabled,server_id,version FROM control.proxies WHERE workspace_id=$1 AND proxy_id=$2',[workspace,p.proxy_id])).rows[0];assert.ok(current);
   if(!current.enabled){assert.equal(current.server_id,null);await api('/v1/proxies/'+p.proxy_id,{expected_version:current.version,enabled:true,server_id:'s3'});}
   else assert.equal(current.server_id,'s3');
   state.activated.push(p.proxy_id);save('handoff',state);
  }
  for(const s of plan.sources){
   if(state.sources.includes(s.source_id))continue;
   const current=(await pool.query('SELECT version,server_ids FROM control.proxy_sources WHERE workspace_id=$1 AND source_id=$2',[workspace,s.source_id])).rows[0];assert.ok(current);
   if(!current.server_ids.includes('s3')){assert.deepEqual(current.server_ids,s.server_ids);await api('/v1/proxy-sources/'+s.source_id,{expected_version:current.version,server_ids:[...current.server_ids,'s3']});}
   state.sources.push(s.source_id);save('handoff',state);
  }
  save('handoff',{...state,activated_at:new Date().toISOString()});console.log(JSON.stringify({phase:'activated',count:state.activated.length,sources:state.sources.length}));
 }else{
  const plan=load('deployment-plan'),state=load('handoff');assert.equal(state.activated.length,plan.proxies.length);
  const current=object(['-n','crawler','get','statefulset','execution-worker']);assert.equal(createHash('sha256').update(JSON.stringify(current.spec)).digest('hex'),plan.original_spec_hash);
  const original=object(['-n','crawler','get','pod','execution-worker-0']);assert.equal(original.metadata.uid,plan.original_uid);
  assert.deepEqual((await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],plan.settings);
  await new Promise<void>((resolve,reject)=>{
   const p=spawn('ssh',['crawl-s3','sudo -n k3s ctr -n k8s.io images import -'],{stdio:['pipe','ignore','pipe']}),input=createReadStream(plan.tarball);
   input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('E4 image import stream closed'));});input.pipe(p.stdin);p.stderr.resume();p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('E4 image import failed')));
  });
  // Create, never apply over an unrelated object. Re-entry verifies the existing
  // resources were produced by this exact plan before waiting for readiness.
  const manager=object(['-n','crawler','get','pods','-l','app.kubernetes.io/name=proxy-manager']).items.find((p:any)=>p.spec.nodeName==='s3');assert.ok(manager);
  let health;
  for(const end=Date.now()+90000;;){
   health=JSON.parse(kube(['-n','crawler','exec',manager.metadata.name,'--','node','-e',"fetch('http://127.0.0.1:18110/healthz').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"]));
   if(health.authorized&&health.qualified>0)break;
   assert.ok(Date.now()<end,'The second node needs qualified YouTube egress before admitting work');await delay(5000);
  }
  for(const r of plan.resources.items){
   const checksum=createHash('sha256').update(JSON.stringify(r)).digest('hex');
   r.metadata.annotations={'crawlsystem/e4-resource-sha256':checksum};
   const raw=kube(['-n','crawler','get',r.kind,r.metadata.name,'--ignore-not-found','-o','json']);
   if(raw){const found=JSON.parse(raw);assert.equal(found.metadata.annotations?.['crawlsystem/e4-resource-sha256'],checksum,'Existing resource must belong to the recorded E4 plan');}
   else kube(['create','-f','-'],JSON.stringify(r));
  }
  kube(['-n','crawler','rollout','status','statefulset/'+setName,'--timeout=150s'],undefined,160000);
  const second=object(['-n','crawler','get','pod',setName+'-0']);assert.equal(second.spec.nodeName,'s3');
  assert.equal(object(['-n','crawler','get','pod','execution-worker-0']).metadata.uid,plan.original_uid);
  save('deployed',{at:new Date().toISOString(),worker_id:second.metadata.name,node:'s3',uid:second.metadata.uid,images:second.spec.containers.map((c:any)=>c.image),proxies:health});
  console.log(JSON.stringify({phase:'deployed',worker_id:second.metadata.name,node:'s3',qualified_proxies:health.qualified,original_worker_preserved:true}));
 }
}catch(error){console.error(JSON.stringify({result:'FAILED',mode,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();}
