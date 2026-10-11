import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {workerId,setName,claimName,object,kube,apiClient,save} from './e4-common.ts';

// Only the new node is drained/restarted. Stable identity, PVC, control version
// and encrypted browser state must survive; no work is moved between queues.
const {api}=await apiClient();const worker=async()=>(await api('/v1/workers?limit=100')).items.find((w:any)=>w.worker_id===workerId);
let changed=false;
const wait=async(check:(w:any)=>boolean,timeout=45000)=>{for(const end=Date.now()+timeout;;){const w=await worker();if(w&&check(w))return w;assert.ok(Date.now()<end,'Second Worker state timed out');await delay(2000);}};
const files=()=>JSON.parse(kube(['-n','crawler','exec',workerId,'-c','worker','--','node','-e',"const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(fs.readdirSync('/browser-state').filter(n=>n.endsWith('.sealed')).sort().map(n=>({name:n,sha256:c.createHash('sha256').update(fs.readFileSync('/browser-state/'+n)).digest('hex')}))))"]));
try{
 const initial=await wait(w=>!w.stale&&w.control.status==='RUNNING');
 changed=true;await api('/v1/workers/'+workerId+'/drain',{command_id:randomUUID(),expected_version:initial.control.version,reason:'E4 新节点重启验收，排空后验证持久身份'});
 const drained=await wait(w=>w.control.status==='DRAINED',60000);
 const before=object(['-n','crawler','get','pod',workerId]),original=object(['-n','crawler','get','pod','execution-worker-0']),volume=object(['-n','crawler','get','pvc',claimName]);
 const identities=files();assert.ok(identities.length>0,'Real collection must have persisted browser identities');
 kube(['-n','crawler','delete','pod',workerId,'--wait=true','--timeout=50s'],undefined,60000);
 kube(['-n','crawler','rollout','status','statefulset/'+setName,'--timeout=60s'],undefined,70000);
 const after=object(['-n','crawler','get','pod',workerId]);assert.notEqual(after.metadata.uid,before.metadata.uid);assert.equal(after.spec.nodeName,'s3');
 const recovered=await wait(w=>!w.stale&&w.control.status==='DRAINED'&&Date.parse(w.last_heartbeat_at)>=Date.parse(after.status.startTime),30000);assert.equal(recovered.control.version,drained.control.version);
 assert.equal(object(['-n','crawler','get','pvc',claimName]).metadata.uid,volume.metadata.uid);assert.deepEqual(files(),identities);
 assert.equal(object(['-n','crawler','get','pod','execution-worker-0']).metadata.uid,original.metadata.uid);
 await api('/v1/workers/'+workerId+'/resume',{command_id:randomUUID(),expected_version:recovered.control.version,reason:'E4 重启验收通过，恢复正常采集'});await wait(w=>w.control.status==='RUNNING');changed=false;
 save('restart',{result:'PASSED',at:new Date().toISOString(),worker_id:workerId,node:'s3',before_uid:before.metadata.uid,after_uid:after.metadata.uid,pvc_uid:volume.metadata.uid,encrypted_identities:identities.length,control_version:recovered.control.version,browser_state_preserved:true,original_worker_preserved:true});console.log(JSON.stringify({result:'PASSED',worker_id:workerId,encrypted_identities:identities.length,browser_state_preserved:true,original_worker_preserved:true}));
}catch(error){console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{if(changed){try{const w=await worker();await api('/v1/workers/'+workerId+'/resume',{command_id:randomUUID(),expected_version:w.control.version,reason:'E4 重启验收退出后恢复接单'});await wait(w=>w.control.status==='RUNNING');}catch{console.error('E4 second Worker restoration needs review');process.exitCode=1;}}}
