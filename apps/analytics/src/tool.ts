// Bounded administration/acceptance publisher. Uses the Pod's existing topic ACLs;
// no credentials or arbitrary Kafka administration are exposed through stdout.
import {pipelineKafka} from '../../raw-parser/src/runtime.ts';
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const input=JSON.parse(Buffer.concat(chunks).toString()) as {operation?:string;topic:string;messages:unknown[]};
if(input.operation==='offsets') {
 const admin=(await pipelineKafka('r5-operations-tool')).admin();
 try{await admin.connect();const offsets=await admin.fetchOffsets({groupId:'crawl-sink-ch',topics:['ops.events']});console.log(JSON.stringify({offsets:offsets[0]?.partitions??[]}));}finally{await admin.disconnect();}
 process.exit(0);
}
if(!['ops.events','dlq.parse','dlq.sink','crawl.raw','crawl.step'].includes(input.topic)||!Array.isArray(input.messages)||input.messages.length>100)throw new Error('Unsupported bounded publish');
const kafka=await pipelineKafka('r5-operations-tool'),producer=kafka.producer({idempotent:true,maxInFlightRequests:1,allowAutoTopicCreation:false});
try{await producer.connect();const offsets=await producer.send({topic:input.topic,acks:-1,messages:input.messages.map(value=>({key:'r5-acceptance',value:JSON.stringify(value)}))});console.log(JSON.stringify({published:input.messages.length,topic:input.topic,offsets}));}finally{await producer.disconnect();}
