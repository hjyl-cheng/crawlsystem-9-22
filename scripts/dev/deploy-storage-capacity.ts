import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {dir,kube,object,save,load,workspace,client} from './storage-capacity-common.ts';
import {StorageCapacitySchema} from '../../packages/contracts/src/storage-capacity.ts';
const pool=createPool(),mode=process.argv[2];
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try{
 if(mode==='prepare'){
  if(!existsSync(dir+'/before.json')){
   save('previous-control-api',object(['-n','control','get','deployment/control-api-preview']),true);
   const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];
   const migrations=(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows;assert.equal(migrations.length,39);
   save('video-identities',(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows,true);
   const workloads=object(['get','deployment,statefulset,daemonset','-A']).items.map((w:any)=>({namespace:w.metadata.namespace,name:w.metadata.name,spec_hash:createHash('sha256').update(JSON.stringify(w.spec)).digest('hex')}));
   const pods=object(['get','pods','-A']).items.filter((p:any)=>!p.metadata.deletionTimestamp).map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,uid:p.metadata.uid,restarts:p.status.containerStatuses?.map((c:any)=>({name:c.name,n:c.restartCount}))}));
   save('before',{at:new Date().toISOString(),settings,migrations,workloads,pods,active_plans:(await pool.query("SELECT plan_id,input_hash,workflow_id,run_id,deadline_at FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace])).rows},true);
  }
  console.log('Storage monitoring deployment baseline saved; no database migrations or MinIO restarts');
 }else if(mode==='import'){
  const build=load('latest-control-image');assert.equal(build.revision,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
  for(const node of ['a1','a2','a3','s1','s2','s3']){
   const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
   await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(build.control.tarball);input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('Image import closed'));});p.stderr.resume();input.pipe(p.stdin);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Control image import failed')));});
  }
  save('imported',{at:new Date().toISOString(),revision:build.revision});console.log('Capacity Control API image imported on all nodes');
 }else if(mode==='deploy'){
  const build=load('latest-control-image');assert.equal(build.revision,load('imported').revision);
  const previous=load('previous-control-api'),current=object(['-n','control','get','deployment/control-api-preview']);
  const actual=current.spec.template.spec.containers.find((c:any)=>c.name==='control-api').image;
  assert.ok([previous.spec.template.spec.containers.find((c:any)=>c.name==='control-api').image,build.control.image].includes(actual));
  const patch={spec:{template:{spec:{containers:[{name:'control-api',image:build.control.image}]}}}};
  kube(['-n','control','patch','deployment/control-api-preview','--type=strategic','--dry-run=server','-p',JSON.stringify(patch)]);
  save('dry-run',{result:'PASSED',revision:build.revision});
  kube(['-n','control','patch','deployment/control-api-preview','--type=strategic','-p',JSON.stringify(patch)]);
  kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s'],undefined,190000);
  const {api}=await client();const capacity=StorageCapacitySchema.parse(await api('/v1/storage/capacity'));assert.equal(capacity.available,true);
  save('deployment',{at:new Date().toISOString(),revision:build.revision,image:build.control.image});console.log('Both Control API replicas ready; live bucket capacity available');
 }else throw new Error('Usage: deploy-storage-capacity prepare|import|deploy');
}catch(error){save('deployment-failure',{phase:mode,error:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined});console.error(JSON.stringify({result:'FAILED',phase:mode,error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;}
finally{await pool.end();}
