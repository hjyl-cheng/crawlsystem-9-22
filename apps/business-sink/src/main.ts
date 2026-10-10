import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {BusinessReceiver,DeliveryMessageSchema,DeliveryValidationError} from './receiver.ts';
import {DeliveryReceiptSchema} from '../../../packages/contracts/src/delivery.ts';
import {pipelineKafka} from '../../raw-parser/src/runtime.ts';
const url=process.env.BUSINESS_DATABASE_URL;if(!url||!process.env.PG_CA_FILE)throw new Error('Business database and TLS configuration required');
if(!/^crawlsystem_business_(main|c1_test(?:_\d+)?)$/.test(new URL(url).pathname.slice(1)))throw new Error('Use a dedicated business database');
const pool=new Pool({connectionString:url,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME},application_name:'business-sink',connectionTimeoutMillis:5000});
pool.on('error',()=>console.error(JSON.stringify({service:'business-sink',code:'DATABASE_UNAVAILABLE'})));
const identity=(await pool.query('SELECT database_kind,database_name FROM publication.database_identity')).rows[0];
if(identity?.database_kind!=='business'||identity.database_name!==new URL(url).pathname.slice(1))throw new Error('Business database identity mismatch');
const receiver=new BusinessReceiver(pool),kafka=await pipelineKafka('business-sink'),consumer=kafka.consumer({groupId:'business-sink',allowAutoTopicCreation:false,sessionTimeout:60000}),producer=kafka.producer({idempotent:true,maxInFlightRequests:1,allowAutoTopicCreation:false});
let ready=false,busy=false,stopping=false,lastTick=Date.now();
const server=createServer((req,res)=>{const ok=req.url==='/healthz'&&ready&&Date.now()-lastTick<120000;res.statusCode=ok?200:503;res.end(ok?'ok':'starting');});server.listen(18103,'0.0.0.0');
await producer.connect();await consumer.connect();consumer.on(consumer.events.GROUP_JOIN,()=>{ready=true;});consumer.on(consumer.events.CRASH,e=>{ready=false;if(!stopping&&!e.payload.restart)process.exit(1);});
await consumer.subscribe({topic:'business.delivery',fromBeginning:true});
await consumer.run({partitionsConsumedConcurrently:1,eachMessage:async m=>{
 let value:unknown;try{value=JSON.parse(m.message.value!.toString());DeliveryMessageSchema.parse(value);}catch{
  await producer.send({topic:'dlq.delivery',messages:[{key:m.message.key,value:JSON.stringify({stage:'BUSINESS',code:'INVALID_MESSAGE',topic:m.topic,partition:m.partition,offset:m.message.offset})}]});return;
 }
 try{await receiver.accept(value);}catch(e){
  if(!(e instanceof DeliveryValidationError))throw e;
  await producer.send({topic:'dlq.delivery',acks:-1,messages:[{key:m.message.key,value:JSON.stringify({stage:'BUSINESS',code:e.code,topic:m.topic,partition:m.partition,offset:m.message.offset})}]});
  const parsed=DeliveryMessageSchema.safeParse(value);
  if(parsed.success){const v=parsed.data,r=DeliveryReceiptSchema.safeParse({delivery_id:v.delivery_id,stream_id:v.stream_id,channel_id:v.channel_id,manifest_hash:v.shard.manifest_hash,status:'FAILED',code:e.code,verified_at:new Date().toISOString(),business_batch_id:null,version_vector:v.version_vector});
   if(r.success)await producer.send({topic:'business.receipts',acks:-1,messages:[{key:r.data.channel_id,value:JSON.stringify(r.data)}]});
  }
 }
 await m.heartbeat();
}});
async function tick(){if(busy||stopping)return;busy=true;try{await receiver.tick(async r=>{await producer.send({topic:'business.receipts',acks:-1,messages:[{key:r.channel_id,value:JSON.stringify(r)}]});});lastTick=Date.now();}catch{console.error(JSON.stringify({service:'business-sink',code:'DEPENDENCY_UNAVAILABLE',durable_work_retained:true}));}finally{busy=false;}}
const timer=setInterval(()=>void tick(),2000);await tick();
for(const s of ['SIGTERM','SIGINT'] as const)process.once(s,()=>{stopping=true;ready=false;clearInterval(timer);void consumer.disconnect().then(()=>producer.disconnect()).then(()=>pool.end()).finally(()=>server.close());});
