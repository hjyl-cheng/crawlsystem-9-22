import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream,existsSync} from 'node:fs';
const dir='.runtime/d3',git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
const kube=(a:string[])=>execFileSync('kubectl',a,{encoding:'utf8',env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
assert.equal(git('status','--porcelain'),'');
const build=JSON.parse(readFileSync(dir+'/latest-control-image.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
if(!existsSync(dir+'/previous-control-api.json'))writeFileSync(dir+'/previous-control-api.json',kube(['-n','control','get','deployment/control-api-preview','-o','json']),{mode:0o600});
for(const node of ['a1','a2','a3','s1','s2','s3']){
  const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
  await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(build.control.tarball);input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('D3 import stream closed'));});input.pipe(p.stdin);p.stderr.resume();p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('D3 Control import failed')));});
}
kube(['-n','control','set','image','deployment/control-api-preview','control-api='+build.control.image]);
kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s']);
// The schema is installed before rolling out. Mark the first completed rollout
// as the start of complete coverage, including requests previously served by old replicas.
if(!existsSync(dir+'/deployment.json')){
  const primary=kube(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
  execFileSync('kubectl',['-n','db','exec','-i',primary,'--','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','crawler'],{input:'UPDATE console.audit_installation SET installed_at=clock_timestamp();',env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['pipe','pipe','pipe'],timeout:30000});
}
writeFileSync(dir+'/deployment.json',JSON.stringify({revision:build.revision,control_image:build.control.image,deployed_at:new Date().toISOString(),workload:'control/control-api-preview'},null,2),{mode:0o600});console.log('D3 Control API ready');
