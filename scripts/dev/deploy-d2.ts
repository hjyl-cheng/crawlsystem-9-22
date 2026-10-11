import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createReadStream,existsSync} from 'node:fs';
const dir='.runtime/d2',git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
const kube=(a:string[])=>execFileSync('kubectl',a,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
assert.equal(git('status','--porcelain'),'');
const build=JSON.parse(readFileSync(dir+'/latest-images.json','utf8'));assert.equal(build.revision,git('rev-parse','HEAD'));
const services=[['control','deployment','control-api-preview','control-api'],['control','deployment','intent-dispatcher','dispatcher'],['crawler','statefulset','execution-worker','worker']] as const;
for(const [ns,kind,name] of services)if(!existsSync(dir+'/previous-'+name+'.json'))writeFileSync(dir+'/previous-'+name+'.json',kube(['-n',ns,'get',kind,name,'-o','json']),{mode:0o600});
const worker=JSON.parse(readFileSync(dir+'/previous-execution-worker.json','utf8'));
const pods=JSON.parse(kube(['-n','crawler','get','pods','-l','app.kubernetes.io/name=execution-worker','-o','json']));
assert.equal(worker.spec.replicas,1,'D2 upgrade handles the currently deployed single StatefulSet Worker');
const nodes=[...new Set<string>(pods.items.map((p:any)=>p.spec.nodeName))];assert.equal(nodes.length,1);
const controlPods=JSON.parse(kube(['-n','control','get','pods','-l','app.kubernetes.io/name in (control-api-preview,intent-dispatcher)','-o','json']));
const imports=new Map<string,Set<string>>();for(const p of controlPods.items){const set=imports.get(p.spec.nodeName)??new Set();set.add('control');imports.set(p.spec.nodeName,set);}for(const node of nodes){const set=imports.get(node)??new Set();set.add('worker');imports.set(node,set);}
// Kubernetes uses a1/a2/... names, while the SSH configuration uses crawl-a1/crawl-a2/....
// A rolling Deployment may choose a different node, so cache Control on every registered node.
for(const node of JSON.parse(kube(['get','nodes','-o','json'])).items.map((n:any)=>n.metadata.name)){assert.match(node,/^(crawl-)?[as][123]$/);const set=imports.get(node)??new Set();set.add('control');imports.set(node,set);}
for(const [node,kinds] of imports)for(const kind of kinds){
 const host=node.startsWith('crawl-')?node:'crawl-'+node;
 const command=host==='crawl-a1'?['sudo','-n','k3s','ctr','-n','k8s.io','images','import','-']:['ssh',host,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
 await new Promise<void>((resolve,reject)=>{const p=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','pipe']}),input=createReadStream(build[kind].tarball);input.on('error',reject);p.stdin.on('error',()=>{input.destroy();reject(new Error('D2 image import stream closed'));});input.pipe(p.stdin);p.stderr.resume();p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('D2 image import failed')));});
}
// Deploy the compatible Control and dispatcher first. Until the new Worker registers,
// dispatch stays on the legacy queue. Frozen workflow IDs, deadlines and budgets survive rollout.
for(const [ns,kind,name,container] of services){kube(['-n',ns,'set','image',kind+'/'+name,container+'='+build[name==='execution-worker'?'worker':'control'].image]);kube(['-n',ns,'rollout','status',kind+'/'+name,'--timeout=180s']);}
writeFileSync(dir+'/deployment.json',JSON.stringify({revision:build.revision,control_image:build.control.image,worker_image:build.worker.image,deployed_at:new Date().toISOString(),services:services.map(s=>s.slice(0,3))},null,2),{mode:0o600});
console.log('D2 API, dispatcher and Worker ready');
