import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

export const dir='.runtime/e4',workspace='m1-main',workerId='execution-worker-s3-0',setName='execution-worker-s3',claimName='execution-browser-state-s3';
mkdirSync(dir,{recursive:true,mode:0o700});
export const save=(name:string,value:unknown,exclusive=false)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:exclusive?'wx':'w'});
export const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
export function kube(args:string[],input?:string,timeout=30000){
 return execFileSync('kubectl',args,{encoding:'utf8',input,timeout,maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe'],env:{...process.env,K3S_CONFIG_FILE:'/dev/null',KUBECTL_REMOTE_COMMAND_WEBSOCKETS:'false'}}).trim();
}
export const object=(args:string[])=>JSON.parse(kube([...args,'-o','json']));
export async function apiClient(){
 const token=await issueToken({subject:'e4-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),900);
 const headers={authorization:'Bearer '+token};
 return {headers,api:async(path:string,body?:unknown)=>{
  const r=await fetch('http://127.0.0.1:18103/api'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,`E4 API ${path}`);return r.json();
 }};
}
