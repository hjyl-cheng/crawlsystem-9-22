import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,createWriteStream,existsSync,readFileSync,renameSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {migrate} from '@crawlsystem/store/migrate';
import {dir,workspace,workerIds,save,load,kube,object,client} from './finish-common.ts';
const mode=process.argv[2],pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
const services=[['control','deployment','control-api-preview','control-api'],['crawler','deployment','raw-parser','parser'],['ingest','deployment','pg-sink','sink'],['crawler','statefulset','execution-worker','worker'],['crawler','statefulset','execution-worker-s3','worker']] as const;
try {
 if(mode==='prepare'){
  if(!existsSync(dir+'/video-identities.json'))save('video-identities',(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows,true);
  if(!existsSync(dir+'/before.json')){
   const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],migrations=(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows;
   save('before',{at:new Date().toISOString(),settings,migrations,active_plans:(await pool.query("SELECT plan_id,input_hash,workflow_id,run_id,deadline_at FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace])).rows,
    pods:object(['get','pods','-A']).items.filter((p:any)=>!p.metadata.deletionTimestamp).map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,uid:p.metadata.uid,restarts:p.status.containerStatuses?.map((c:any)=>({name:c.name,n:c.restartCount}))})),
    workloads:object(['get','deployment,statefulset,daemonset','-A']).items.map((w:any)=>({namespace:w.metadata.namespace,name:w.metadata.name,spec_hash:createHash('sha256').update(JSON.stringify(w.spec)).digest('hex')}))},true);
  }
  for(const [ns,kind,name] of services)if(!existsSync(`${dir}/previous-${name}.json`))save('previous-'+name,object(['-n',ns,'get',kind,name]),true);
  if(!existsSync(dir+'/source-before.dump')){
   const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
   await new Promise<void>((resolve,reject)=>{const output=createWriteStream(dir+'/source-before.dump.partial',{mode:0o600}),p=spawn('kubectl',['-n','db','exec',primary,'--','pg_dump','-U','postgres','-d','crawlsystem_m1_main_test','-Fc'],{env:{...process.env,K3S_CONFIG_FILE:'/dev/null',KUBECTL_REMOTE_COMMAND_WEBSOCKETS:'false'},stdio:['ignore','pipe','pipe']});let ended=false,finished=false;
    const done=()=>{if(ended&&finished){renameSync(dir+'/source-before.dump.partial',dir+'/source-before.dump');resolve();}};p.stdout.pipe(output);p.stderr.resume();p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error('Completion backup failed'));else{ended=true;done();}});output.on('error',reject);output.on('finish',()=>{finished=true;done();});});
  }
  const hash=createHash('sha256');for await(const b of createReadStream(dir+'/source-before.dump'))hash.update(b);
  await migrate(pool);
  assert.deepEqual((await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],load('before').settings);
  save('bootstrap',{schema:39,backup_bytes:statSync(dir+'/source-before.dump').size,backup_sha256:hash.digest('hex'),settings_preserved:true});
  console.log('Completion backup, additive migrations and configuration retention verified');
 }else if(mode==='drain'||mode==='resume'){
  const {api}=await client();
  if(mode==='drain'&&!existsSync(dir+'/worker-before.json'))save('worker-before',(await api('/v1/workers?limit=100')).items.filter((w:any)=>workerIds.includes(w.worker_id)),true);
  for(const id of workerIds){
   const old=load('worker-before').find((w:any)=>w.worker_id===id);assert.ok(old);
   const current=(await api('/v1/workers?limit=100')).items.find((w:any)=>w.worker_id===id);assert.ok(current);
   const action=mode==='drain'?'drain':old.control.desired==='PAUSED'?'pause':'resume';
   if(mode==='drain'&&current.control.status==='DRAINED')continue;
   await api('/v1/workers/'+id+'/'+action,{command_id:crypto.randomUUID(),expected_version:current.control.version,reason:'系统收尾升级：安全排空并恢复原接单状态'});
  }
  for(const end=Date.now()+180000;;){const workers=(await api('/v1/workers?limit=100')).items.filter((w:any)=>workerIds.includes(w.worker_id));
   if(workers.length===2&&workers.every((w:any)=>mode==='drain'?w.control.status==='DRAINED':!w.stale&&w.collector.gateway==='ready'&&w.control.status===(load('worker-before').find((o:any)=>o.worker_id===w.worker_id).control.desired==='PAUSED'?'PAUSED':'RUNNING'))){save('workers-'+mode,{at:new Date().toISOString(),workers});break;}
   if(Date.now()>=end)throw new Error('Worker state transition pending');await delay(2000);
  }
  console.log('Both Workers '+mode+' verified');
 }else if(mode==='import'){
  const build=load('latest-images');assert.equal(build.revision,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
  for(const node of ['a1','a2','a3','s1','s2','s3'])for(const image of [build.control,...(['s2','s3'].includes(node)?[build.worker]:[])]){
   const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
   await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(image.tarball);input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('Image import closed'));});p.stderr.resume();input.pipe(p.stdin);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Image import failed')));});
  }
  save('imported',{at:new Date().toISOString(),revision:build.revision});console.log('Control and Worker images imported');
 }else if(mode==='control'||mode==='workers'){
  const build=load('latest-images');assert.equal(build.revision,load('imported').revision);assert.equal((await pool.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n,39);
  const {api}=await client(),workers=(await api('/v1/workers?limit=100')).items;assert.ok(workerIds.every(id=>workers.some((w:any)=>w.worker_id===id&&w.control.status==='DRAINED')));
  if(mode==='control'){
   const encoded=Buffer.from(readFileSync('.runtime/youtube-data-api-key','utf8').trim()).toString('base64'),secretName='youtube-handle-data-api';
   const existing=JSON.parse(kube(['-n','control','get','secret',secretName,'--ignore-not-found','-o','json'])||'null');
   if(existing)assert.equal(existing.data.key,encoded,'Existing handle key differs');
   else kube(['create','-f','-'],JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:secretName,namespace:'control'},type:'Opaque',data:{key:encoded}}));
   const patch={spec:{template:{spec:{volumes:[{name:'youtube-handle',secret:{secretName,defaultMode:288,items:[{key:'key',path:'key'}]}}],containers:[{name:'control-api',image:build.control.image,env:[{name:'YOUTUBE_DATA_API_KEY_FILE',value:'/youtube-handle/key'}],volumeMounts:[{name:'youtube-handle',mountPath:'/youtube-handle',readOnly:true}]}]}}}};
   kube(['-n','control','patch','deployment/control-api-preview','--type=strategic','-p',JSON.stringify(patch)]);
   kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s'],undefined,190000);
  }
  for(const [ns,kind,name,container] of services.filter(s=>mode==='workers'?s[1]==='statefulset':s[1]==='deployment'&&s[2]!=='control-api-preview')){
   kube(['-n',ns,'set','image',kind+'/'+name,container+'='+(mode==='workers'?build.worker.image:build.control.image)]);kube(['-n',ns,'rollout','status',kind+'/'+name,'--timeout=180s'],undefined,190000);
  }
  save('deployed-'+mode,{at:new Date().toISOString(),revision:build.revision});console.log('Completion '+mode+' workloads ready');
 }else throw new Error('Usage: deploy-completion prepare|drain|import|control|workers|resume');
}catch(error){console.error(JSON.stringify({result:'FAILED',phase:mode,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();}
