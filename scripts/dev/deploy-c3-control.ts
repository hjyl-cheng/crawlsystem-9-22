import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream,existsSync} from 'node:fs';
const dir='.runtime/c3',git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
const kube=(a:string[])=>execFileSync('kubectl',a,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
assert.equal(git('status','--porcelain'),'');
const build=JSON.parse(readFileSync(`${dir}/latest-control-image.json`,'utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
if(!existsSync(`${dir}/previous-control-api.json`))writeFileSync(`${dir}/previous-control-api.json`,kube(['-n','control','get','deployment/control-api-preview','-o','json']),{mode:0o600});
for(const node of ['a1','a2','a3','s1','s2','s3']){
 const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
 await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(build.control.tarball).pipe(p.stdin);p.stderr.resume();p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('Control image import failed on '+node)));});
}
kube(['apply','-f','apps/control-api/deploy/overview-monitoring.yaml']);
const patch={spec:{template:{spec:{containers:[{name:'control-api',image:build.control.image,env:[{name:'PROMETHEUS_URL',value:'http://prometheus.monitoring.svc.cluster.local:9090'}]}]}}}};
kube(['-n','control','patch','deployment/control-api-preview','--type=strategic','-p',JSON.stringify(patch)]);
kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s']);
writeFileSync(`${dir}/deployment.json`,JSON.stringify({revision:build.revision,control_image:build.control.image,deployed_at:new Date().toISOString(),workload:'control/control-api-preview'},null,2),{mode:0o600});console.log('C3 Control API ready');
