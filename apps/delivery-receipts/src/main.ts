import {createPool} from '@crawlsystem/store/config';
import {createServer} from 'node:http';
import {pipelineKafka} from '../../raw-parser/src/runtime.ts';
import {DeliveryReceiptSchema} from '../../../packages/contracts/src/delivery.ts';
import {applyDeliveryReceipt} from '../../../packages/store/src/publication.ts';
const pool=createPool(),kafka=await pipelineKafka('delivery-receipts'),consumer=kafka.consumer({groupId:'delivery-receipts',allowAutoTopicCreation:false,sessionTimeout:60000});
let ready=false,stopping=false;
const server=createServer((req,res)=>{res.statusCode=req.url==='/healthz'&&ready?200:503;res.end(ready?'ok':'starting');});server.listen(18103,'0.0.0.0');
await consumer.connect();consumer.on(consumer.events.GROUP_JOIN,()=>{ready=true;});consumer.on(consumer.events.CRASH,e=>{ready=false;const diagnostic=JSON.stringify({service:'delivery-receipts',code:'CONSUMER_CRASH',error_name:e.payload.error.name})+'\n';if(!stopping&&!e.payload.restart)process.stderr.write(diagnostic,()=>process.exit(1));else process.stderr.write(diagnostic);});await consumer.subscribe({topic:'business.receipts',fromBeginning:true});
await consumer.run({partitionsConsumedConcurrently:1,eachMessage:async m=>{
 let receipt;try{receipt=DeliveryReceiptSchema.parse(JSON.parse(m.message.value!.toString()));}catch{console.error(JSON.stringify({service:'delivery-receipts',code:'INVALID_RECEIPT',partition:m.partition,offset:m.message.offset}));return;}
 const client=await pool.connect();
 try{await client.query('BEGIN');await applyDeliveryReceipt(client,receipt);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');if(e instanceof Error&&/^RECEIPT_(IDENTITY|VERSION)_MISMATCH$/.test(e.message)){console.error(JSON.stringify({service:'delivery-receipts',code:e.message,partition:m.partition,offset:m.message.offset}));return;}throw e;}finally{client.release();}
}});
const cleanup=setInterval(()=>{void pool.query('SELECT delivery.cleanup_outbox(200)').catch(()=>console.error(JSON.stringify({service:'delivery-receipts',code:'CLEANUP_UNAVAILABLE'})));},300000);
for(const s of ['SIGTERM','SIGINT'] as const)process.once(s,()=>{stopping=true;ready=false;clearInterval(cleanup);void consumer.disconnect().then(()=>pool.end()).finally(()=>server.close());});
