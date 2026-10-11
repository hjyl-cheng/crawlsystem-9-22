import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream,existsSync} from 'node:fs';
const dir='.runtime/d1',git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
const kube=(a:string[])=>execFileSync('kubectl',a,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
assert.equal(git('status','--porcelain'),'');
const build=JSON.parse(readFileSync(dir+'/latest-control-image.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
const services=[['crawler','daemonset','proxy-manager','proxy-manager'],['control','deployment','control-api-preview','control-api'],['control','deployment','intent-dispatcher','dispatcher']] as const;
for(const [ns,kind,name] of services)if(!existsSync(dir+'/previous-'+name+'.json'))writeFileSync(dir+'/previous-'+name+'.json',kube(['-n',ns,'get',kind,name,'-o','json']),{mode:0o600});
for(const node of ['a1','a2','a3','s1','s2','s3']){
 const command=node==='a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',`crawl-${node}`,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
 await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']});createReadStream(build.control.tarball).pipe(p.stdin);p.stderr.resume();p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('D1 image import failed')));});
}
// First roll the optional-field-compatible proxy client against the old API, then the new API and dispatcher.
for(const [ns,kind,name,container] of services){kube(['-n',ns,'set','image',kind+'/'+name,container+'='+build.control.image]);kube(['-n',ns,'rollout','status',kind+'/'+name,'--timeout=180s']);}
writeFileSync(dir+'/deployment.json',JSON.stringify({revision:build.revision,control_image:build.control.image,deployed_at:new Date().toISOString(),services:services.map(s=>s.slice(0,3))},null,2),{mode:0o600});
console.log('D1 API, dispatcher and six proxy nodes ready');
