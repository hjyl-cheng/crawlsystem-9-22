import {execFileSync} from 'node:child_process';
import {chmodSync,cpSync,existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ensureProfileRuntime,PYTHON_BASE} from './profile-agent-runtime.ts';
import {ensureFingerprintRuntime} from './fingerprint-runtime.ts';
import {build} from 'esbuild';
import {bundleWorkflowCode} from '@temporalio/worker';

// Builds the deployable images from a clean, committed revision:
// - control: Control API, Ingest and the intent dispatcher as single esbuild bundles on Alpine.
// - worker: the Temporal Worker on glibc (the Temporal core bridge only ships gnu binaries),
//   with @temporalio/* kept as real node_modules so the SDK sees one module instance.
// - profile-agent: the Python local-model inference service (built only when its content changes).
// Images are written as tarballs for per-node import; there is no registry yet.
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain')&&process.env.ALLOW_DIRTY_BUILD!=='true')throw new Error('Commit and review source before building a deployable image');
const revision=git('rev-parse','HEAD'),short=revision.slice(0,12);
const bases={
  control:'node:22.22.1-alpine@sha256:92d51e5f20b7ff58faa5a969af1a1cec6cbec3fbff7e0f523242b9b5c85ad887',
  worker:'node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d',
};
const out=resolve('.runtime',`images-${short}`);rmSync(out,{recursive:true,force:true});
const sha=(...files:string[])=>{const h=createHash('sha256');for(const f of files)h.update(readFileSync(f));return h.digest('hex');};
const common={bundle:true,platform:'node' as const,format:'esm' as const,target:'node22',minify:true,external:['pg-native'],
  banner:{js:"import{createRequire}from'node:module';const require=createRequire(import.meta.url);"},define:{'process.env.BUILD_VERSION':JSON.stringify(revision)}};

function image(name:'control'|'worker',root:string,contentHash:string){
  const tag=`docker.io/crawlsystem/${name==='control'?'control-api':'execution-worker'}:main-${short}-${contentHash.slice(0,8)}`;
  const layer=join(out,`${name}-layer.tar`),tar=join(out,`${name}.tar`);
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-C',root,'-cf',layer,'app'],{stdio:'inherit'});
  execFileSync('crane',['append','--platform','linux/amd64','--base',bases[name],'--new_layer',layer,'--new_tag',tag,'--output',tar],{stdio:'inherit',timeout:180000});
  rmSync(layer);return {image:tag,tarball:tar,content_sha256:contentHash,base:bases[name]};
}

// Control image: same layout as before (/app/control-api.mjs) plus Ingest and dispatcher entries.
const controlRoot=join(out,'control');mkdirSync(controlRoot+'/app',{recursive:true});
const entries={'control-api':'apps/control-api/src/main.ts',ingest:'apps/ingest/src/main.ts',dispatcher:'apps/control-api/src/dispatch-main.ts','temporal-cert-sync':'apps/control-api/src/temporal-cert-sync-main.ts','proxy-manager':'apps/proxy-manager/src/main.ts',
  'raw-parser':'apps/raw-parser/src/main.ts','pg-sink':'apps/pg-sink/src/main.ts'};
for(const [name,entry] of Object.entries(entries))await build({...common,entryPoints:[entry],outfile:`${controlRoot}/app/${name}.mjs`});
const control=image('control',controlRoot,sha(...Object.keys(entries).map(n=>`${controlRoot}/app/${n}.mjs`)));

// Worker image: /app/worker/src/main.mjs resolves ../dist/workflow-bundle.cjs exactly as in the repo.
const workerRoot=join(out,'worker'),app=join(workerRoot,'app/worker');mkdirSync(app+'/src',{recursive:true});mkdirSync(app+'/dist');
await build({...common,entryPoints:['apps/execution-worker/src/main.ts'],outfile:app+'/src/main.mjs',external:[...common.external,'@temporalio/*']});
await build({...common,entryPoints:['apps/execution-worker/scripts/query-once.ts'],outfile:app+'/src/query-once.mjs',external:[...common.external,'@temporalio/*']});
const workflow=await bundleWorkflowCode({workflowsPath:resolve('apps/execution-worker/src/workflows.ts'),logger:{log(){},trace(){},debug(){},info(){},warn(){},error(){}} as never});
writeFileSync(app+'/dist/workflow-bundle.cjs',workflow.code);
// Copy the installed dependency closure of the Temporal packages from the lockfile-installed tree.
const seen=new Set<string>();
function resolvePackage(name:string,from:string):string|undefined{
  for(let dir=from;;dir=dirname(dir)){const candidate=join(dir,'node_modules',name);if(existsSync(join(candidate,'package.json')))return candidate;if(dir===process.cwd()||dir==='/')return undefined;}
}
function visit(dir:string){
  if(seen.has(dir))return;seen.add(dir);
  const manifest=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
  for(const dep of Object.keys(manifest.dependencies??{})){const found=resolvePackage(dep,dir);if(!found)throw new Error(`Missing dependency ${dep} of ${dir}`);visit(found);}
  for(const dep of Object.keys(manifest.optionalDependencies??{})){const found=resolvePackage(dep,dir);if(found)visit(found);}
}
for(const name of ['@temporalio/worker','@temporalio/activity','@temporalio/common','@temporalio/workflow'])visit(resolve('node_modules',name));
// Only linux-x64-gnu native code runs here; Rust sources and other platforms are dropped.
const skipPackage=/^node_modules\/@swc\/core-(?!linux-x64-gnu$)/;
const skipBridge=/^(sdk-core|src|bridge-macros|Cargo\.(toml|lock)|releases\/(?!x86_64-unknown-linux-gnu))(\/|$)/;
const copied:string[]=[];
for(const dir of [...seen].sort()){
  const rel=relative(process.cwd(),dir);if(skipPackage.test(rel))continue;
  const bridge=rel==='node_modules/@temporalio/core-bridge';
  // Nested node_modules are separate closure entries; copy only what was resolved.
  cpSync(dir,join(app,rel),{recursive:true,filter:src=>{const r=relative(dir,src);return !/^node_modules(\/|$)/.test(r)&&!(bridge&&skipBridge.test(r));}});
  copied.push(rel);
}
const releases=join(app,'node_modules/@temporalio/core-bridge/releases');
if(!existsSync(join(releases,'x86_64-unknown-linux-gnu')))throw new Error('Temporal core bridge linux-x64-gnu binary is missing');
writeFileSync(app+'/package.json',JSON.stringify({name:'crawlsystem-execution-worker',private:true,type:'module'})+'\n');
const lock=createHash('sha256').update(readFileSync('package-lock.json')).update(copied.join('\n')).digest('hex');
const worker=image('worker',workerRoot,createHash('sha256').update(sha(app+'/src/main.mjs',app+'/src/query-once.mjs',app+'/dist/workflow-bundle.cjs')).update(lock).digest('hex'));

// Profile Agent image: pinned CPython base + locked wheels + verified model bundle + inference source.
// Tagged by content only, so an unchanged Agent is neither rebuilt nor re-imported on later deploys.
const runtime=await ensureProfileRuntime(m=>console.log(`profile-agent: ${m}`));
const profileSources=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='__pycache__'?[]:e.isDirectory()?profileSources(join(dir,e.name)):[join(dir,e.name)]).sort();
const profileFiles=[...profileSources('apps/profile-agent/qy_channel_profile'),...profileSources('apps/profile-agent/profile_agent'),'apps/profile-agent/requirements.lock','apps/profile-agent/model-manifest.json'];
const profileHash=createHash('sha256').update(PYTHON_BASE).update(profileFiles.join('\n')).update(sha(...profileFiles)).digest('hex');
const profileTag=`docker.io/crawlsystem/profile-agent:${profileHash.slice(0,16)}`,profileTar=resolve('.runtime/profile-agent/images',`${profileHash.slice(0,16)}.tar`);
if(!existsSync(profileTar)){
  const stage=join(out,'profile'),layer=join(out,'profile-layer.tar');
  mkdirSync(stage+'/app/src',{recursive:true});
  // Hard links: the wheels and models are hundreds of MB and never modified in place.
  execFileSync('cp',['-al',runtime.site,stage+'/app/site']);execFileSync('cp',['-al',runtime.models,stage+'/app/models']);
  for(const dir of ['qy_channel_profile','profile_agent'])cpSync(`apps/profile-agent/${dir}`,`${stage}/app/src/${dir}`,{recursive:true,filter:src=>!src.includes('__pycache__')});
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--exclude=.prepared','-C',stage,'-cf',layer,'app'],{stdio:'inherit'});
  mkdirSync(dirname(profileTar),{recursive:true});
  execFileSync('crane',['append','--platform','linux/amd64','--base',PYTHON_BASE,'--new_layer',layer,'--new_tag',profileTag,'--output',profileTar+'.partial'],{stdio:'inherit',timeout:280000});
  execFileSync('mv',[profileTar+'.partial',profileTar]);rmSync(layer);rmSync(stage,{recursive:true,force:true});
}
const profile={image:profileTag,tarball:profileTar,content_sha256:profileHash,base:PYTHON_BASE};

const fingerprintRuntime=await ensureFingerprintRuntime();
const fingerprintFiles=[...profileSources('apps/fingerprint-gateway/fingerprint_gateway'),'apps/fingerprint-gateway/requirements.lock'];
const fingerprintHash=createHash('sha256').update(PYTHON_BASE).update(sha(...fingerprintFiles)).digest('hex');
const fingerprintTag=`docker.io/crawlsystem/fingerprint-gateway:${fingerprintHash.slice(0,16)}`,fingerprintTar=resolve('.runtime/fingerprint-gateway/images',`${fingerprintHash.slice(0,16)}.tar`);
if(!existsSync(fingerprintTar)){
  const stage=join(out,'fingerprint'),layer=join(out,'fingerprint-layer.tar'); mkdirSync(stage+'/app/src',{recursive:true});
  execFileSync('cp',['-al',fingerprintRuntime.site,stage+'/app/site']);
  chmodSync(stage+'/app/site',0o755);
  cpSync('apps/fingerprint-gateway/fingerprint_gateway',stage+'/app/src/fingerprint_gateway',{recursive:true,filter:src=>!src.includes('__pycache__')});
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--exclude=.prepared','-C',stage,'-cf',layer,'app'],{stdio:'inherit'});
  mkdirSync(dirname(fingerprintTar),{recursive:true});
  execFileSync('crane',['append','--platform','linux/amd64','--base',PYTHON_BASE,'--new_layer',layer,'--new_tag',fingerprintTag,'--output',fingerprintTar],{stdio:'inherit',timeout:180000});
  rmSync(layer);rmSync(stage,{recursive:true,force:true});
}
const fingerprint={image:fingerprintTag,tarball:fingerprintTar,content_sha256:fingerprintHash,base:PYTHON_BASE};

const metadata={revision,built_at:new Date().toISOString(),control,worker,profile,fingerprint,worker_packages:copied.length};
writeFileSync(join(out,'build.json'),JSON.stringify(metadata,null,2)+'\n');
writeFileSync('.runtime/latest-images.json',JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify(metadata,null,2));
