import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';

const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:190000}).trim();
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
assert.equal(git('status','--porcelain'),'');
const controlOnly=process.argv.includes('--control-only');
const build=JSON.parse(readFileSync(controlOnly?'.runtime/r6/latest-control-image.json':'.runtime/latest-images.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
const targets=[['control','deployment','control-api-preview','control-api'],['control','deployment','intent-dispatcher','dispatcher'],
  ['crawler','deployment','raw-parser','parser'],['ingest','deployment','pg-sink','sink'],['analytics','deployment','crawl-analytics','analytics'],
  ['crawler','deployment','profile-agent','profile-agent'],['crawler','statefulset','execution-worker','worker']] as const;
if(!existsSync('.runtime/r6/before-fix-workloads.json'))writeFileSync('.runtime/r6/before-fix-workloads.json',JSON.stringify(targets.map(([namespace,kind,name])=>({namespace,kind,name,object:JSON.parse(kube(['-n',namespace,'get',kind,name,'-o','json']))}))),{mode:0o600});
const env=(ns:string,name:string,settings:string[])=>kube(['-n',ns,'set','env',`deployment/${name}`,...settings]);
const ready=(ns:string,kind:string,name:string)=>kube(['-n',ns,'rollout','status',`${kind}/${name}`,'--timeout=180s']);
// Pause creation, finish already admitted work, then replace the collector with its state intact.
env('control','control-api-preview',['QUERY_RUNS_ENABLED=false','QUERY_AUTO_ADMIT=false','UPDATE_SCHEDULER_ENABLED=false']);
env('control','intent-dispatcher',['UPDATE_SCHEDULER_ENABLED=false','QUERY_AUTO_ADMIT=false']);
ready('control','deployment','control-api-preview');ready('control','deployment','intent-dispatcher');
const pool=createPool();
try {
  for(const end=Date.now()+180000;;) {
    const busy=(await pool.query("SELECT (SELECT count(*) FROM control.plans WHERE workspace_id='m1-main' AND status IN ('QUEUED','RUNNING','WAITING'))+(SELECT count(*) FROM control.query_runs WHERE workspace_id='m1-main' AND state='RUNNING') AS n")).rows[0].n;
    if(Number(busy)===0)break;assert.ok(Date.now()<end,'Wait for active executions before replacing Worker');await delay(2000);
  }
}finally{await pool.end();}
console.log('R6 creation paused; active work settled');
for(const node of ['a1','a2','a3','s1','s2','s3']) {
  for(const artifact of controlOnly?[build.control]:[build.control,build.worker,build.profile]) {
    const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
    await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(artifact.tarball).pipe(p.stdin);p.stderr.resume();p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error(`Image import failed on ${node}`)));});
  }
  console.log(`R6 images imported on ${node}`);
}
for(const [ns,kind,name,container] of targets) {
  if(controlOnly&&['profile-agent','execution-worker'].includes(name))continue;
  const image=name==='profile-agent'?build.profile.image:name==='execution-worker'?build.worker.image:build.control.image;
  if(name==='execution-worker') {
    const object=JSON.parse(kube(['-n',ns,'get',kind,name,'-o','json']));
    for(const c of object.spec.template.spec.containers)if(c.name==='worker'){
      c.image=image;const version=c.env.find((e:any)=>e.name==='BUILD_VERSION');if(version)version.value=build.revision;else c.env.push({name:'BUILD_VERSION',value:build.revision});
    }else if(c.name==='fingerprint-gateway')c.env=c.env.filter((e:any)=>e.name!=='QUERY_RUNNER_SLOTS');
    delete object.status;delete object.metadata.managedFields;kube(['replace','-f','-'],JSON.stringify(object));
  }else kube(['-n',ns,'set','image',`${kind}/${name}`,`${container}=${image}`]);
  ready(ns,kind,name);console.log(`R6 ${name} ready`);
}
env('control','control-api-preview',['QUERY_RUNS_ENABLED=true','QUERY_AUTO_ADMIT=true','UPDATE_SCHEDULER_ENABLED=true']);ready('control','deployment','control-api-preview');
env('control','intent-dispatcher',['UPDATE_SCHEDULER_ENABLED=true','QUERY_AUTO_ADMIT=true']);ready('control','deployment','intent-dispatcher');
writeFileSync(controlOnly?'.runtime/r6/import-recovery-deployment.json':'.runtime/r6/fix-deployment.json',JSON.stringify({revision:build.revision,deployed_at:new Date().toISOString(),control_image:build.control.image,...(controlOnly?{}:{worker_image:build.worker.image,profile_image:build.profile.image})},null,2),{mode:0o600});
console.log('R6 fixes deployed; bounded automatic scheduling restored');
