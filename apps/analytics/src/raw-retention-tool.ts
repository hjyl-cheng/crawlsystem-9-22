// Bounded rollout acceptance, using the same workload identity and deletion path.
import {pipelineApi,secret} from '../../raw-parser/src/runtime.ts';
import {MinioStore} from '../../execution-worker/src/raw-archive.ts';
import {cleanRawBatch} from './raw-retention.ts';
const dir=process.env.RAW_RETENTION_CREDENTIALS_DIRECTORY;if(!dir)throw new Error('Retention credentials required');
const access=await secret(dir,'access_key'),key=await secret(dir,'secret_key'),endpoint=process.env.MINIO_URL??'http://minio.storage.svc.cluster.local:9000';
const raw=new MinioStore(endpoint,'crawl-raw',access,key),parsed=new MinioStore(endpoint,'crawl-parsed',access,key),api=await pipelineApi();
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const input=JSON.parse(Buffer.concat(chunks).toString());
if(input.operation==='batch') {
 const limit=input.limit;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid bounded limit');
 const items=await api.rawCleanupClaim(limit),results=await cleanRawBatch(items,raw,parsed);
 if(results.length)await api.rawCleanupDone(results);
 console.log(JSON.stringify({items,results}));
}else if(input.operation==='head') {
 if(!Array.isArray(input.refs)||input.refs.length>200)throw new Error('Invalid head batch');
 const refs=[];
 for(const ref of input.refs) {
  if(!['crawl-raw','crawl-parsed','crawl-evidence'].includes(ref.bucket)||typeof ref.key!=='string')throw new Error('Invalid bucket');
  const useEvidenceReader=ref.bucket==='crawl-evidence'||ref.bucket==='crawl-raw'&&ref.key.startsWith('failures/');
  const store=useEvidenceReader?new MinioStore(endpoint,ref.bucket,await secret('/minio','access_key'),await secret('/minio','secret_key')):ref.bucket==='crawl-raw'?raw:parsed;
  refs.push({...ref,actual_bytes:await store.head(ref.key,AbortSignal.timeout(10_000))});
 }
 console.log(JSON.stringify({refs}));
}else if(input.operation==='permissions') {
 const denied=[];
 for(const [bucket,objectKey] of [['crawl-parsed','v1/m1-main/retention-permission-probe'],['crawl-evidence','retention-permission-probe'],['crawl-raw','v1/other-workspace/retention-permission-probe'],['crawl-raw','failures/v1/m1-main/retention-permission-probe']]) {
  try {await new MinioStore(endpoint,bucket!,access,key).remove(objectKey!,AbortSignal.timeout(10_000));throw new Error('Delete grant exceeds retention scope');}
  catch(error) {if(!(error instanceof Error)||error.name!=='ArchiveError')throw error;denied.push({bucket,key:objectKey});}
 }
 console.log(JSON.stringify({denied}));
}else throw new Error('Unsupported retention operation');
