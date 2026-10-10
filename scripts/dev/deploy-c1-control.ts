import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream} from 'node:fs';
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
assert.equal(git('status','--porcelain'),'');
const build=JSON.parse(readFileSync('.runtime/c1/latest-control-image.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
for(const node of ['a1','a2','a3','s1','s2','s3']){
 const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
 await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(build.control.tarball).pipe(p.stdin);p.stderr.resume();p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error(`Control image import failed on ${node}`)));});
}
const targets=[['control','control-api-preview','control-api'],['control','intent-dispatcher','dispatcher'],['crawler','raw-parser','parser'],['ingest','pg-sink','sink'],['analytics','crawl-analytics','analytics'],['ingest','business-sink','business-sink'],['control','delivery-receipts','delivery-receipts']] as const;
for(const [namespace,name,container] of targets)kube(['-n',namespace,'set','image',`deployment/${name}`,`${container}=${build.control.image}`]);
for(const [namespace,name] of targets){kube(['-n',namespace,'rollout','status',`deployment/${name}`,'--timeout=180s']);console.log(`${name} ready`);}
writeFileSync('.runtime/c1/control-fix.json',JSON.stringify({revision:build.revision,control_image:build.control.image,deployed_at:new Date().toISOString()},null,2),{mode:0o600});
