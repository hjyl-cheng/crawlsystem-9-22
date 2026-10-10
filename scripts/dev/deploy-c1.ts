import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';

const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:190000}).trim();
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
assert.equal(git('status','--porcelain'),'');
const controlOnly=false;
const build=JSON.parse(readFileSync('.runtime/latest-images.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
const targets=[['control','deployment','control-api-preview','control-api'],['control','deployment','intent-dispatcher','dispatcher'],
  ['crawler','deployment','raw-parser','parser'],['ingest','deployment','pg-sink','sink'],['analytics','deployment','crawl-analytics','analytics'],
  ['crawler','deployment','profile-agent','profile-agent'],['crawler','statefulset','execution-worker','worker']] as const;
if(!existsSync('.runtime/c1/previous-workloads.json'))writeFileSync('.runtime/c1/previous-workloads.json',JSON.stringify(targets.map(([namespace,kind,name])=>({namespace,kind,name,object:JSON.parse(kube(['-n',namespace,'get',kind,name,'-o','json']))}))),{mode:0o600});
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
console.log('C1 creation paused; active work settled');
for(const node of ['a1','a2','a3','s1','s2','s3']) {
  for(const artifact of controlOnly?[build.control]:[build.control,build.worker,build.profile]) {
    const list=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','ls','-q']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','ls','-q'];
    if(execFileSync(list[0]!,list.slice(1),{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\n').includes(artifact.image))continue;
    const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
    await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(artifact.tarball).pipe(p.stdin);p.stderr.resume();p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error(`Image import failed on ${node}`)));});
  }
  console.log(`C1 images imported on ${node}`);
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
  ready(ns,kind,name);console.log(`C1 ${name} ready`);
}
env('control','control-api-preview',['QUERY_RUNS_ENABLED=true','QUERY_AUTO_ADMIT=true','UPDATE_SCHEDULER_ENABLED=true']);ready('control','deployment','control-api-preview');
env('control','intent-dispatcher',['UPDATE_SCHEDULER_ENABLED=true','QUERY_AUTO_ADMIT=true']);ready('control','deployment','intent-dispatcher');
writeFileSync('.runtime/c1/deployment.json',JSON.stringify({revision:build.revision,deployed_at:new Date().toISOString(),control_image:build.control.image,...(controlOnly?{}:{worker_image:build.worker.image,profile_image:build.profile.image})},null,2),{mode:0o600});
console.log('C1 fixes deployed; bounded automatic scheduling restored');
for(const [namespace,name,entry,secretName,kafkaSecret,dbEnv] of [
 ['ingest','business-sink','business-sink','c1-business-db','kafka-business-sink','BUSINESS_DATABASE_URL'],
 ['control','delivery-receipts','delivery-receipts','c1-receipts-db','kafka-delivery-receipts','DATABASE_URL'],
] as const) {
 const object={apiVersion:'apps/v1',kind:'Deployment',metadata:{namespace,name},spec:{replicas:1,strategy:{type:'Recreate'},selector:{matchLabels:{'app.kubernetes.io/name':name}},template:{metadata:{labels:{'app.kubernetes.io/name':name}},spec:{automountServiceAccountToken:false,enableServiceLinks:false,
 securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,fsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},
 containers:[{name,image:build.control.image,imagePullPolicy:'Never',command:['node',`/app/${entry}.mjs`],ports:[{name:'http',containerPort:18103}],
  env:[{name:dbEnv,valueFrom:{secretKeyRef:{name:secretName,key:'database-url'}}},{name:'PG_CA_FILE',value:'/pg/pg-ca.crt'},{name:'PG_TLS_SERVERNAME',value:'crawler-pg-pool.db.svc.cluster.local'},{name:'KAFKA_CREDENTIALS_DIRECTORY',value:'/kafka'},{name:'NODE_OPTIONS',value:'--max-old-space-size=256'}],
  volumeMounts:[{name:'kafka',mountPath:'/kafka',readOnly:true},{name:'pg',mountPath:'/pg',readOnly:true}],
  readinessProbe:{httpGet:{path:'/healthz',port:'http'},initialDelaySeconds:5,periodSeconds:10},livenessProbe:{httpGet:{path:'/healthz',port:'http'},initialDelaySeconds:60,periodSeconds:20,failureThreshold:6},
  resources:{requests:{cpu:'50m',memory:'64Mi'},limits:{cpu:'500m',memory:'384Mi'}},securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}}}],
 volumes:[{name:'kafka',secret:{secretName:kafkaSecret,defaultMode:288}},{name:'pg',secret:{secretName,defaultMode:288,items:[{key:'pg-ca.crt',path:'pg-ca.crt'}]}}]}}}};
 kube(['apply','-f','-'],JSON.stringify(object));ready(namespace,'deployment',name);console.log(`C1 ${name} ready`);
}
