import { MinioStore } from '../../execution-worker/src/raw-archive.ts';
import { RawParser } from './parser.ts';
import { pipelineApi,pipelineBus,secret } from './runtime.ts';
const dir=process.env.MINIO_CREDENTIALS_DIRECTORY??'/var/run/crawlsystem/minio',endpoint=process.env.MINIO_URL??'http://minio.storage.svc.cluster.local:9000';
const access=await secret(dir,'access_key'),key=await secret(dir,'secret_key'),api=await pipelineApi(),bus=await pipelineBus('crawl-parser');
const parser=new RawParser({raw:new MinioStore(endpoint,'crawl-raw',access,key),parsed:new MinioStore(endpoint,'crawl-parsed',access,key),
  loadPlan:ref=>api.input(ref.plan_id),publish:(topic,channel,fact)=>bus.send(topic,channel,fact)});
await bus.run(['crawl.raw'],async m=>{
  await parser.parse(JSON.parse(m.message.value!.toString()),AbortSignal.timeout(120000));
},'dlq.parse');
