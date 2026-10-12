import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
export const dir='.runtime/finish',workspace='m1-main',workerIds=['execution-worker-0','execution-worker-s3-0'];
mkdirSync(dir,{recursive:true,mode:0o700});
export const save=(name:string,value:unknown,exclusive=false)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:exclusive?'wx':'w'});
export const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
export function kube(args:string[],input?:string,timeout=30000){return execFileSync('kubectl',args,{encoding:'utf8',input,timeout,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe'],env:{...process.env,K3S_CONFIG_FILE:'/dev/null',KUBECTL_REMOTE_COMMAND_WEBSOCKETS:'false'}}).trim();}
export const object=(args:string[])=>JSON.parse(kube([...args,'-o','json']));
export async function client(){
 const token=await issueToken({subject:'completion-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),900),headers={authorization:'Bearer '+token};
 return {headers,api:async(path:string,body?:unknown)=>{const r=await fetch('http://127.0.0.1:18103/api'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200,`Completion API ${path}`);return r.json();}};
}
