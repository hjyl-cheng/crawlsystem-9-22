import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {createReadStream,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {temporalJwks,temporalKeyId} from '@crawlsystem/http/temporal-token';

// Deploys the M1 preview stack from the images built by build-images.ts:
// Control (2), Ingest (2), intent dispatcher (1), Proxy Manager (per node),
// Profile Agent (1), execution Worker (1) and the
// Temporal client certificate sync. There is no registry: images are imported
// into containerd on every node first. Secrets are derived from existing cluster
// Secrets; nothing secret is read into this process's output or written to Git.
const kubectl=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']}).trim();
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const build=JSON.parse(readFileSync('.runtime/latest-images.json','utf8')) as {revision:string;control:{image:string;tarball:string};worker:{image:string;tarball:string};profile:{image:string;tarball:string};fingerprint:{image:string;tarball:string}};
if(build.revision!==git('rev-parse','HEAD'))throw new Error('latest-images.json is not built from HEAD; rebuild first');
if(git('status','--porcelain'))throw new Error('Deploy only from a clean, committed tree');
const tagOf=(image:string)=>image.split(':').at(-1)!;
const nodes=['a1','a2','a3','s1','s2','s3'];
const step=(message:string)=>process.stdout.write(`${new Date().toISOString()} ${message}\n`);

// 1. Import images where missing. a1 is this host; others via the deploy SSH aliases.
async function importImage(node:string,image:string,tarball:string){
  const remote=node==='a1'?[]:['ssh',`crawl-${node}`];
  const run=(command:string[])=>spawnSync(remote[0]??command[0]!,remote.length?[...remote.slice(1),...command]:command.slice(1),{encoding:'utf8'});
  if(run(['sudo','-n','k3s','ctr','-n','k8s.io','images','ls','-q',`name==${image}`]).stdout.trim()===image)return 'present';
  const command=[...remote,'sudo','-n','k3s','ctr','-n','k8s.io','images','import','-'];
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(command[0]!,command.slice(1),{stdio:['pipe','ignore','inherit']});
    createReadStream(tarball).pipe(child.stdin);
    child.on('exit',code=>code===0?resolve():reject(new Error(`image import on ${node} exited ${code}`)));child.on('error',reject);
  });
  if(run(['sudo','-n','k3s','ctr','-n','k8s.io','images','ls','-q',`name==${image}`]).stdout.trim()!==image)throw new Error(`${image} missing on ${node} after import`);
  return 'imported';
}
const imports:Record<string,Record<string,string>>={};
for(const node of nodes){imports[node]={};for(const artifact of [build.control,build.worker,build.profile,build.fingerprint])imports[node]![artifact.image]=await importImage(node,artifact.image,artifact.tarball);step(`images on ${node}: ${JSON.stringify(imports[node])}`);}

// 2. Record what runs now, for rollback.
const current=(namespace:string,kind:string,name:string)=>{try{return kubectl(['-n',namespace,'get',kind,name,'-o','jsonpath={.spec.template.spec.containers[0].image}']);}catch{return null;}};
const previous={control:current('control','deployment','control-api-preview'),ingest:current('ingest','deployment','ingest-preview'),
  dispatcher:current('control','deployment','intent-dispatcher'),worker:current('crawler','statefulset','execution-worker'),profile:current('crawler','deployment','profile-agent')};

const render=(file:string)=>readFileSync(file,'utf8').replaceAll('control-api:IMAGE_TAG',`control-api:${tagOf(build.control.image)}`)
  .replaceAll('execution-worker:IMAGE_TAG',`execution-worker:${tagOf(build.worker.image)}`).replaceAll('profile-agent:PROFILE_TAG',`profile-agent:${tagOf(build.profile.image)}`)
  .replaceAll('fingerprint-gateway:FINGERPRINT_TAG',`fingerprint-gateway:${tagOf(build.fingerprint.image)}`).replaceAll('BUILD_REVISION',build.revision);
const apply=(file:string)=>step(kubectl(['apply','-f','-'],render(file)).split('\n').join('; '));
const secretData=(namespace:string,name:string)=>JSON.parse(kubectl(['-n',namespace,'get','secret',name,'-o','json'])).data as Record<string,string>;
const putSecret=(namespace:string,name:string,data:Record<string,string>)=>kubectl(['apply','-f','-'],JSON.stringify({apiVersion:'v1',kind:'Secret',type:'Opaque',metadata:{name,namespace},data}));
const pick=(data:Record<string,string>,keys:string[])=>Object.fromEntries(keys.map(key=>{if(!data[key])throw new Error(`secret key ${key} missing`);return [key,data[key]];}));

// 3. Temporal client identities: issue, wait, then seed the consumer Secrets (the CronJob keeps them current).
apply('deploy/m1-preview/temporal-clients.yaml');
for(const name of ['crawlsystem-m1-dispatcher','crawlsystem-m1-worker'])kubectl(['-n','temporal','wait','--for=condition=Ready',`certificate/${name}`,'--timeout=120s']);
const tlsKeys=['ca.crt','tls.crt','tls.key'];
putSecret('control','temporal-client-dispatcher',pick(secretData('temporal','crawlsystem-m1-dispatcher-tls'),tlsKeys));
putSecret('crawler','temporal-client-worker',pick(secretData('temporal','crawlsystem-m1-worker-tls'),tlsKeys));
// 4. Ingest uses the same facts database and verification key as Control.
putSecret('ingest','ingest-preview',pick(secretData('control','control-api-preview'),['database-url','pg-ca.crt','jwt-secret']));
// 5. Temporal namespace tokens: ES256 private key only in Control; public JWKS for the frontend.
// previous.pem (if present) stays in the JWKS during a key rotation so live tokens keep working.
mkdirSync('.runtime/temporal-jwt',{recursive:true,mode:0o700});
if(!existsSync('.runtime/temporal-jwt/signing.pem'))writeFileSync('.runtime/temporal-jwt/signing.pem',generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const signing=readFileSync('.runtime/temporal-jwt/signing.pem','utf8');
const published=[signing,...(existsSync('.runtime/temporal-jwt/previous.pem')?[readFileSync('.runtime/temporal-jwt/previous.pem','utf8')]:[])];
putSecret('control','temporal-jwt-signing',{'signing.pem':Buffer.from(signing).toString('base64')});
kubectl(['apply','-f','-'],JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'temporal-jwks',namespace:'temporal'},data:{'jwks.json':JSON.stringify(await temporalJwks(published))}}));
// Proxy credential sealing key: generated once and kept; losing it makes stored proxy passwords unreadable.
if(!existsSync('.runtime/proxy-credential.key'))writeFileSync('.runtime/proxy-credential.key',randomBytes(32).toString('base64')+'\n',{mode:0o600});
if(!existsSync('.runtime/youtube-data-api-key'))throw new Error('.runtime/youtube-data-api-key is required for the collector');
putSecret('crawler','youtube-data-api',{key:Buffer.from(readFileSync('.runtime/youtube-data-api-key','utf8').trim()).toString('base64')});
putSecret('control','proxy-credential-key',{key:Buffer.from(readFileSync('.runtime/proxy-credential.key','utf8')).toString('base64')});
// Browser identities must survive Pod replacement; keep the encryption key independently of images.
if(!kubectl(['-n','crawler','get','secret','browser-identity-key','--ignore-not-found','-o','name']))
  putSecret('crawler','browser-identity-key',{key:Buffer.from(randomBytes(32).toString('hex')).toString('base64')});
for(const name of ['minio-crawl-worker','kafka-crawl-worker']) secretData('crawler',name);
step(`secrets ready: control/temporal-client-dispatcher, control/proxy-credential-key, crawler/temporal-client-worker, ingest/ingest-preview, Temporal signing key ${temporalKeyId(signing)}`);

// 6. Roll out in dependency order: Control (token exchange) and Ingest before Workers.
const rollouts:[string,string,string][]=[['control-api','control','deployment/control-api-preview'],['ingest','ingest','deployment/ingest-preview'],
  ['dispatcher','control','deployment/intent-dispatcher'],['proxy-manager','crawler','daemonset/proxy-manager'],['profile-agent','crawler','deployment/profile-agent'],['execution-worker','crawler','statefulset/execution-worker']];
for(const [file,namespace,resource] of rollouts){
  apply(`deploy/m1-preview/${file}.yaml`);
  kubectl(['-n',namespace,'rollout','status',resource,'--timeout=240s']);step(`${resource} rolled out`);
}
const record={revision:build.revision,deployed_at:new Date().toISOString(),control_image:build.control.image,worker_image:build.worker.image,profile_image:build.profile.image,fingerprint_image:build.fingerprint.image,imports,previous,
  rollback:'kubectl set image to the previous images (still imported on every node); delete intent-dispatcher / execution-worker if previous is null.'};
writeFileSync(`.runtime/deploy-${build.revision.slice(0,12)}.json`,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record,null,2));
