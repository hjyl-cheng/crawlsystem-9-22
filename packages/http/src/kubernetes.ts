import { readFileSync } from 'node:fs';
import { request } from 'node:https';

// Minimal in-cluster Kubernetes API call using the Pod's own ServiceAccount.
// Kept dependency-free; callers are limited by RBAC to the few verbs they need.
export interface KubernetesResponse { status:number; body:unknown; }
export type KubernetesCall=(method:'GET'|'POST'|'PATCH',path:string,body?:unknown,contentType?:string)=>Promise<KubernetesResponse>;
export function inClusterKubernetes(env:NodeJS.ProcessEnv=process.env):KubernetesCall {
  const root=env.KUBERNETES_SERVICE_ACCOUNT_DIR??'/var/run/secrets/kubernetes.io/serviceaccount';
  const host=env.KUBERNETES_SERVICE_HOST,port=Number(env.KUBERNETES_SERVICE_PORT??'443');
  if(!host) throw new Error('KUBERNETES_SERVICE_HOST is required');
  const ca=readFileSync(`${root}/ca.crt`);
  return (method,path,body,contentType='application/json')=>new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    // The credential is read per call: kubelet rotates the projected token file.
    const headers:Record<string,string|number>={authorization:`Bearer ${readFileSync(`${root}/token`,'utf8').trim()}`,accept:'application/json'};
    if(payload!==undefined){headers['content-type']=contentType;headers['content-length']=Buffer.byteLength(payload);}
    const call=request({host,port,method,path,ca,timeout:5000,headers},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>262144)call.destroy(new Error('Kubernetes response too large'));else chunks.push(chunk);});
      response.on('end',()=>{
        try {resolve({status:response.statusCode??0,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined});}
        catch(error) {reject(error);}
      });
    });
    call.on('timeout',()=>call.destroy(new Error('Kubernetes API timeout')));
    call.on('error',reject);
    call.end(payload);
  });
}
