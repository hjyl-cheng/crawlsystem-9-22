import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {kube,object,workspace,workerIds,client} from './finish-common.ts';

// No migration, configuration edits or input re-freezing. Upgrade readers before
// writers can freeze recovery_video_ids. Each phase has its own bounded check.
const dir='.runtime/failure-governance',mode=process.argv[2],pool=createPool();
const save=(name:string,value:unknown)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const services={
 workers:[['crawler','statefulset','execution-worker','worker'],['crawler','statefulset','execution-worker-s3','worker']],
 parser:[['crawler','deployment','raw-parser','parser']],sink:[['ingest','deployment','pg-sink','sink']],
 control:[['control','deployment','control-api-preview','control-api']],dispatcher:[['control','deployment','intent-dispatcher','dispatcher']]
} as const;
const config=async()=>({settings:(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],
 migrations:(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows});
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 if(mode==='prepare') {
  if(!existsSync(dir+'/recovery-deployment-before.json')) {
   const {api}=await client(),workers=(await api('/v1/workers?limit=100')).items.filter((w:any)=>workerIds.includes(w.worker_id));
   assert.equal(workers.length,2);assert.ok(workers.every((w:any)=>['RUNNING','PAUSED'].includes(w.control.status)));
   for(const [ns,kind,name] of Object.values(services).flat())save('recovery-previous-'+name,object(['-n',ns,'get',kind,name]));
   save('recovery-deployment-before',{at:new Date().toISOString(),...await config(),workers,
    workloads:object(['get','deployment,statefulset,daemonset','-A']).items.map((w:any)=>({namespace:w.metadata.namespace,name:w.metadata.name,
     hash:createHash('sha256').update(JSON.stringify(w.spec)).digest('hex')}))});
  }
  assert.equal(load('recovery-deployment-before').migrations.length,40);console.log('Fresh configuration and rollback baseline saved');
 }else if(mode==='import') {
  assert.equal(git('status','--porcelain'),'');const build=load('latest-images');assert.equal(build.revision,git('rev-parse','HEAD'));
  for(const node of ['a1','a2','a3','s1','s2','s3'])for(const image of [build.control,...(['s2','s3'].includes(node)?[build.worker]:[])]) {
   const cmd=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
   await new Promise<void>((resolve,reject)=>{const p=spawn(cmd[0]!,cmd.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(image.tarball);
    input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('Image import closed'));});p.stderr.resume();input.pipe(p.stdin);
    p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Image import failed')));});
  }
  save('recovery-imported',{revision:build.revision,at:new Date().toISOString()});console.log('Control and Worker images imported');
 }else if(mode==='drain'||mode==='resume') {
  const before=load('recovery-deployment-before'),{api}=await client();
  for(const id of workerIds) {
   const current=(await api('/v1/workers?limit=100')).items.find((w:any)=>w.worker_id===id);assert.ok(current);
   const action=mode==='drain'?'drain':before.workers.find((w:any)=>w.worker_id===id).control.desired==='PAUSED'?'pause':'resume';
   if(mode==='drain'&&current.control.status==='DRAINED')continue;
   await api('/v1/workers/'+id+'/'+action,{command_id:randomUUID(),expected_version:current.control.version,reason:'失败治理升级：排空在途采集并恢复升级前接单状态'});
  }
  for(const end=Date.now()+180_000;;) {
   const workers=(await api('/v1/workers?limit=100')).items.filter((w:any)=>workerIds.includes(w.worker_id));
   if(workers.length===2&&workers.every((w:any)=>mode==='drain'?w.control.status==='DRAINED':!w.stale&&w.collector.gateway==='ready'&&
    w.control.status===(before.workers.find((old:any)=>old.worker_id===w.worker_id).control.desired==='PAUSED'?'PAUSED':'RUNNING'))) {
    save('recovery-workers-'+mode,{at:new Date().toISOString(),workers});break;
   }
   assert.ok(Date.now()<end,'Worker transition timeout');await delay(2_000);
  }
  console.log('Both Workers '+mode+' verified');
 }else if(mode&&mode in services) {
  const build=load('latest-images');assert.equal(build.revision,load('recovery-imported').revision);
  const {api}=await client(),workers=(await api('/v1/workers?limit=100')).items;
  assert.ok(workerIds.every(id=>workers.some((w:any)=>w.worker_id===id&&w.control.status==='DRAINED')));
  if(mode!=='workers')assert.equal(load('recovery-deployed-workers').revision,build.revision);
  assert.deepEqual(await config(),{settings:load('recovery-deployment-before').settings,migrations:load('recovery-deployment-before').migrations});
  for(const [ns,kind,name,container] of services[mode as keyof typeof services]) {
   kube(['-n',ns,'set','image',kind+'/'+name,container+'='+(mode==='workers'?build.worker.image:build.control.image)]);
   kube(['-n',ns,'rollout','status',kind+'/'+name,'--timeout=100s'],undefined,110_000);
  }
  save('recovery-deployed-'+mode,{revision:build.revision,at:new Date().toISOString()});console.log(mode+' ready');
 }else if(mode==='verify') {
  const build=load('latest-images'),before=load('recovery-deployment-before');
  assert.deepEqual(await config(),{settings:before.settings,migrations:before.migrations});
  const workloads=object(['get','deployment,statefulset,daemonset','-A']).items;
  const changed=Object.values(services).flat().map(s=>s[0]+'/'+s[2]);
  for(const old of before.workloads.filter((w:any)=>!changed.includes(w.namespace+'/'+w.name))) {
   const w=workloads.find((w:any)=>w.metadata.namespace===old.namespace&&w.metadata.name===old.name);assert.ok(w);
   assert.equal(createHash('sha256').update(JSON.stringify(w.spec)).digest('hex'),old.hash,'Unrelated workload changed');
  }
  for(const [ns,kind,name,container] of Object.values(services).flat()) {
   const w=object(['-n',ns,'get',kind,name]);assert.equal(w.spec.template.spec.containers.find((c:any)=>c.name===container).image,kind==='statefulset'?build.worker.image:build.control.image);
   assert.equal(w.status.readyReplicas,w.spec.replicas);
  }
  const {api}=await client(),workers=(await api('/v1/workers?limit=100')).items.filter((w:any)=>workerIds.includes(w.worker_id));
  save('recovery-deployment',{at:new Date().toISOString(),revision:build.revision,migrations_preserved:40,settings_version:before.settings.version,unrelated_workloads_preserved:true,workers});
  console.log(JSON.stringify({result:'PASSED',schema:40,settings_version:before.settings.version,upgraded_services:6}));
 }else throw new Error('Usage: deploy-failure-governance prepare|import|drain|workers|parser|sink|control|dispatcher|resume|verify');
}catch(error) {
 save('recovery-deployment-error',{phase:mode,at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined});
 console.error(JSON.stringify({result:'FAILED',phase:mode,error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}finally {await pool.end();}
