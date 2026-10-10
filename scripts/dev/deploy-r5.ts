import {execFileSync,spawn} from 'node:child_process';
import {createReadStream,readFileSync,writeFileSync,existsSync} from 'node:fs';
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']}).trim();
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw new Error('Deploy a clean committed revision');
const build=JSON.parse(readFileSync('.runtime/latest-images.json','utf8'));
if(build.revision!==git('rev-parse','HEAD'))throw new Error('Build revision differs from HEAD');
const previous=[];
for(const [ns,kind,name] of [['control','deployment','control-api-preview'],['control','deployment','intent-dispatcher'],['crawler','deployment','raw-parser'],['ingest','deployment','pg-sink'],['crawler','statefulset','execution-worker']] as const)
 previous.push({namespace:ns,kind,name,object:JSON.parse(kube(['-n',ns,'get',kind,name,'-o','json']))});
if(!existsSync('.runtime/r5/previous-deployments.json'))writeFileSync('.runtime/r5/previous-deployments.json',JSON.stringify(previous),{mode:0o600});
for(const node of ['a1','a2','a3','s1','s2','s3']) {
 for(const artifact of [build.control,build.worker]) {
  const prefix=node==='a1'?[]:['ssh',`crawl-${node}`];
  const command=[...prefix,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
  await new Promise<void>((resolve,reject)=>{const child=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(artifact.tarball).pipe(child.stdin);child.stderr.resume();child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Image import failed')));});
 }console.log(`R5 images imported on ${node}`);
}
for(const script of ['migrate.ts','configure-pipeline-db.ts','backfill-r5.ts'])execFileSync(process.execPath,['--env-file=.runtime/main.env','--import','tsx',`scripts/dev/${script}`],{stdio:'inherit'});
const render=(file:string)=>readFileSync(file,'utf8').replaceAll('control-api:IMAGE_TAG',build.control.image.replace('docker.io/crawlsystem/','')).replaceAll('execution-worker:IMAGE_TAG',build.worker.image.replace('docker.io/crawlsystem/',''));
// Additive schema and scoped credentials precede the API; Workers follow only after the API is ready.
const apiFile='deploy/m1-preview/control-api.yaml';kube(['apply','-f','-'],render(apiFile));
// Explicitly retain every paused business switch even when older manifests omitted one.
kube(['-n','control','set','env','deployment/control-api-preview','QUERY_RUNS_ENABLED=false','QUERY_AUTO_ADMIT=false','UPDATE_SCHEDULER_ENABLED=false']);
kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s']);console.log('R5 Control API ready');
// Update images in place so all existing runtime settings, browser state and certificates persist.
for(const item of previous.filter(x=>x.name!=='control-api-preview')) {
 const object=JSON.parse(kube(['-n',item.namespace,'get',item.kind,item.name,'-o','json']));
 for(const container of object.spec.template.spec.containers)if(container.image.startsWith('docker.io/crawlsystem/control-api:'))container.image=build.control.image;else if(container.image.startsWith('docker.io/crawlsystem/execution-worker:'))container.image=build.worker.image;
 delete object.status;delete object.metadata.managedFields;
 kube(['replace','-f','-'],JSON.stringify(object));kube(['-n',item.namespace,'rollout','status',`${item.kind}/${item.name}`,'--timeout=180s']);console.log(`R5 ${item.name} ready`);
}
kube(['apply','-f','-'],render('deploy/m1-preview/analytics.yaml'));kube(['-n','analytics','rollout','status','deployment/crawl-analytics','--timeout=180s']);
writeFileSync('.runtime/r5/deployment.json',JSON.stringify({revision:build.revision,control_image:build.control.image,worker_image:build.worker.image,deployed_at:new Date().toISOString(),previous_revision:previous[0]?.object.spec.template.spec.containers[0].image},null,2));
console.log('R5 analytics service ready; automatic business scheduling remains paused');
