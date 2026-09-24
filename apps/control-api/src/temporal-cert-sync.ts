import { z } from 'zod';
import { inClusterKubernetes, type KubernetesCall } from '@crawlsystem/http/kubernetes';

// cert-manager can only issue Temporal client certificates in the `temporal`
// namespace (namespaced CA Issuer). This job copies each renewed client secret
// to the one namespace that uses it. Clients restart themselves when the mounted
// files change (see execution-client watchTlsFiles). RBAC: get on the named
// sources, get/patch on the named targets; targets are pre-created at deploy.
const Pair=z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+\/[a-z0-9-]+$/);
const Secret=z.object({data:z.record(z.string(),z.string()).optional()});
const KEYS=['ca.crt','tls.crt','tls.key'] as const;
export async function syncTemporalClientSecrets(call:KubernetesCall,sourceNamespace:string,pairs:string[]):Promise<{target:string;changed:boolean}[]> {
  const results=[];
  for(const pair of pairs.map(p=>Pair.parse(p.trim()))) {
    const [source,target]=pair.split(':') as [string,string];const [namespace,name]=target.split('/') as [string,string];
    const from=await call('GET',`/api/v1/namespaces/${sourceNamespace}/secrets/${source}`);
    if(from.status!==200) throw new Error(`Reading ${sourceNamespace}/${source} failed with HTTP ${from.status}`);
    const data=Secret.parse(from.body).data??{};
    for(const key of KEYS) if(!data[key]) throw new Error(`${sourceNamespace}/${source} has no ${key}; certificate not issued yet`);
    const to=await call('GET',`/api/v1/namespaces/${namespace}/secrets/${name}`);
    if(to.status!==200) throw new Error(`Reading ${target} failed with HTTP ${to.status}; create it at deploy time`);
    const current=Secret.parse(to.body).data??{};
    const changed=KEYS.some(key=>current[key]!==data[key]);
    if(changed) {
      const patched=await call('PATCH',`/api/v1/namespaces/${namespace}/secrets/${name}`,{data:Object.fromEntries(KEYS.map(key=>[key,data[key]]))},'application/merge-patch+json');
      if(patched.status!==200) throw new Error(`Updating ${target} failed with HTTP ${patched.status}`);
    }
    results.push({target,changed});
  }
  return results;
}
