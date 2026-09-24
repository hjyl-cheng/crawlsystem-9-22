import {execFileSync} from 'node:child_process';
import {copyFileSync,createReadStream,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Prepares the Profile Agent runtime under .runtime/profile-agent, identical for tests and the image:
// - python/: the pinned base image's /usr/local (CPython 3.12), so local tests use the production interpreter;
// - site/:   wheels from apps/profile-agent/requirements.lock (hash-checked, binary only);
// - models/: the model bundle copied from the old system's Git LFS checkout, each file verified against
//            the pinned apps/profile-agent/model-manifest.json. Models are never committed to this repository.
export const PYTHON_BASE='python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e';
const root=resolve('.runtime/profile-agent');
export const runtimePaths={root,python:join(root,'python/usr/local'),site:join(root,'site'),models:join(root,'models')};
const sha256=(file:string)=>new Promise<string>((ok,fail)=>{const h=createHash('sha256');createReadStream(file).on('data',d=>h.update(d)).on('end',()=>ok(h.digest('hex'))).on('error',fail);});
const marker=(dir:string)=>join(dir,'.prepared');
const prepared=(dir:string,key:string)=>existsSync(marker(dir))&&readFileSync(marker(dir),'utf8')===key;

export async function ensureProfileRuntime(log:(m:string)=>void=()=>{}):Promise<typeof runtimePaths>{
  mkdirSync(root,{recursive:true,mode:0o700});
  const pythonDir=join(root,'python');
  if(!prepared(pythonDir,PYTHON_BASE)){
    log(`extracting ${PYTHON_BASE}`);
    rmSync(pythonDir,{recursive:true,force:true});mkdirSync(pythonDir);
    execFileSync('bash',['-o','pipefail','-c',`crane export --platform linux/amd64 '${PYTHON_BASE}' - | tar -x -C '${pythonDir}' usr/local`],{stdio:'inherit',timeout:300_000});
    writeFileSync(marker(pythonDir),PYTHON_BASE);
  }
  const lock=readFileSync('apps/profile-agent/requirements.lock','utf8'),lockKey=createHash('sha256').update(lock).digest('hex');
  if(!prepared(runtimePaths.site,lockKey)){
    log('installing locked wheels');
    rmSync(runtimePaths.site,{recursive:true,force:true});
    execFileSync(join(runtimePaths.python,'bin/python3.12'),['-m','pip','install','--quiet','--disable-pip-version-check','--no-compile','--no-deps','--only-binary=:all:',
      '--require-hashes','--target',runtimePaths.site,'-r','apps/profile-agent/requirements.lock'],{stdio:'inherit',timeout:300_000,env:{...process.env,LD_LIBRARY_PATH:join(runtimePaths.python,'lib')}});
    writeFileSync(marker(runtimePaths.site),lockKey);
  }
  const manifestText=readFileSync('apps/profile-agent/model-manifest.json','utf8'),manifestKey=createHash('sha256').update(manifestText).digest('hex');
  if(!prepared(runtimePaths.models,manifestKey)){
    const source=resolve(process.env.PROFILE_MODEL_SOURCE??'../oldsystem/services/local-agent/models');
    log(`copying model bundle from ${source}`);
    rmSync(runtimePaths.models,{recursive:true,force:true});mkdirSync(join(runtimePaths.models,'artifacts'),{recursive:true});
    const manifest=JSON.parse(manifestText) as {artifacts:{artifact_id:string;relative_path:string;sha256:string;status:string}[]};
    for(const artifact of manifest.artifacts.filter(a=>a.status!=='disabled')){
      if(!/^artifacts\/[\w.-]+$/.test(artifact.relative_path))throw new Error(`Unexpected artifact path ${artifact.relative_path}`);
      const from=join(source,artifact.relative_path),to=join(runtimePaths.models,artifact.relative_path);
      if(!existsSync(from))throw new Error(`${from} is missing; run git lfs pull in the old system checkout`);
      copyFileSync(from,to);
      if(`sha256:${await sha256(to)}`!==artifact.sha256)throw new Error(`${artifact.artifact_id} does not match the pinned manifest (Git LFS pointer instead of the model?)`);
    }
    writeFileSync(join(runtimePaths.models,'manifest.json'),manifestText);
    writeFileSync(marker(runtimePaths.models),manifestKey);
  }
  return runtimePaths;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const paths=await ensureProfileRuntime(m=>console.log(m));
  console.log(JSON.stringify(paths));
}
