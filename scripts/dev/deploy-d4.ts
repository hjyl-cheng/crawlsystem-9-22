import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream,existsSync} from 'node:fs';
const dir='.runtime/d4',git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',env:{...process.env,K3S_CONFIG_FILE:'/dev/null'},stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
try{
  assert.equal(git('status','--porcelain'),'');
  const build=JSON.parse(readFileSync(dir+'/latest-control-image.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
  assert.equal(JSON.parse(readFileSync(dir+'/bootstrap.json','utf8')).schema,35);
  if(!existsSync(dir+'/previous-control-api.json'))writeFileSync(dir+'/previous-control-api.json',kube(['-n','control','get','deployment/control-api-preview','-o','json']),{mode:0o600});
  for(const node of ['a1','a2','a3','s1','s2','s3']){
    const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh','crawl-'+node,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
    await new Promise<void>((resolve,reject)=>{
      const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(build.control.tarball);
      input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('D4 import stream closed'));});input.pipe(p.stdin);p.stderr.resume();
      p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('D4 Control import failed')));
    });
  }
  kube(['-n','control','set','image','deployment/control-api-preview','control-api='+build.control.image]);
  kube(['-n','control','rollout','status','deployment/control-api-preview','--timeout=180s']);
  writeFileSync(dir+'/deployment.json',JSON.stringify({revision:build.revision,control_image:build.control.image,deployed_at:new Date().toISOString(),workload:'control/control-api-preview'},null,2),{mode:0o600});
  console.log('D4 Control API ready');
}catch(error){console.error('D4 deployment failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
