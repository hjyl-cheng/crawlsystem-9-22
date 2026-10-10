import { execFileSync,spawn } from 'node:child_process';
import { mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
const kubectl=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
mkdirSync('.runtime/r3',{recursive:true,mode:0o700});
const dir=mkdtempSync('.runtime/r3/comment-migration-');
try {
  const data=JSON.parse(kubectl(['-n','crawler','get','secret','minio-crawl-parser','-o','json'])).data;
  for(const key of ['access_key','secret_key'])writeFileSync(`${dir}/${key}`,Buffer.from(data[key],'base64'),{mode:0o600});
  const endpoint=`http://${kubectl(['-n','storage','get','service','minio','-o','jsonpath={.spec.clusterIP}'])}:9000`;
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['--env-file=.runtime/main.env','--import','tsx','scripts/dev/migrate-comments.ts'],{env:{...process.env,MINIO_URL:endpoint,MINIO_CREDENTIALS_DIRECTORY:dir},stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Comment migration stopped; originals for unverified objects remain in PG')));
  });
}finally{rmSync(dir,{recursive:true,force:true});}
