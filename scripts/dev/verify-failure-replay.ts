import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {RawParser} from '../../apps/raw-parser/src/parser.ts';
import type {RawUnit} from '../../apps/execution-worker/src/raw-archive.ts';
import type {PlanInput} from '@crawlsystem/contracts';
import {RawReferenceSchema} from '@crawlsystem/contracts/pipeline';

// Captures and plan contexts are private audit files, downloaded read-only.
// This verifier has no database, object-storage client or Kafka publisher.
const dir='.runtime/failure-governance',samples=dir+'/samples';
const results:unknown[]=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Offline verification cannot access the network');};
try {
 const files=readdirSync(samples).filter(name=>name.endsWith('.json')).sort();
 assert.ok(files.length>0,'Download protected failure samples before verification');
 for(const name of files) {
  const saved=JSON.parse(readFileSync(samples+'/'+name,'utf8')) as {ref:unknown;context:PlanInput};
  const ref=RawReferenceSchema.parse(saved.ref),source=readFileSync(samples+'/'+name.replace(/\.json$/,'.raw.gz'));
  assert.equal(source.length,ref.bytes);
  assert.equal(createHash('sha256').update(source).digest('hex'),ref.sha256);
  const unit=JSON.parse(gunzipSync(source,{maxOutputLength:64*1024*1024}).toString()) as RawUnit;
  const parsed=new Map<string,Uint8Array>();let published=0;
  const parser=new RawParser({raw:{get:async key=>{assert.equal(key,ref.key);return source;},put:async()=>{throw new Error('Raw writes are forbidden');}},
   parsed:{get:async key=>parsed.get(key)??null,put:async(key,bytes)=>{assert.ok(!parsed.has(key));parsed.set(key,bytes);}},
   loadPlan:async()=>saved.context,publish:async()=>{published++;}});
  const fact=await parser.parse(ref,AbortSignal.timeout(15_000));
  assert.ok(fact&&fact.kind==='VIDEO'&&!('unavailable' in fact.payload),'Archived successful metadata must decode');
  if(fact.kind!=='VIDEO'||'unavailable' in fact.payload)throw new Error('Unexpected fact');
  // Compare the independent result with the collector solely as an audit check.
  // The parser is never allowed to use the collector projection as its input.
  const projection=unit.result as Record<string,unknown>;
  for(const field of ['source_content_id','channel_id','title','published_at','content_type'] as const)
   assert.deepEqual(fact.payload[field],projection[field],field);
  for(const field of ['duration_seconds','view_count','like_count','comment_count'] as const) {
   const decoded:Record<string,unknown>={...fact.payload[field]},original:Record<string,unknown>={...(projection[field] as object)};
   delete decoded.observed_at;delete original.observed_at;
   assert.deepEqual(decoded,original,field);
  }
  assert.equal(fact.payload.comments_first_page,null);
  const comments=fact.payload.comments_ref;
  if(comments) {
   const bytes=parsed.get(comments.key);assert.ok(bytes);
   assert.equal(createHash('sha256').update(bytes).digest('hex'),comments.sha256);
   assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()).comments,(projection.comments_first_page as {comments:unknown[]}).comments);
  }else assert.equal(projection.comments_first_page,null);
  assert.equal(published,1);
  results.push({failure_id:name.slice(0,-5),plan_id:ref.plan_id,unit_id:ref.unit_id,source_sha256:ref.sha256,
   captured_responses:unit.responses.length,comments:fact.payload.comments_summary?.returned_count??0,parsed_objects_in_memory:parsed.size});
 }
 const evidence={result:'PASSED',at:new Date().toISOString(),production_writes:0,network_requests:0,results};
 writeFileSync(dir+'/offline-replay.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({result:'PASSED',samples:results.length,production_writes:0,network_requests:0}));
}catch(error) {
 writeFileSync(dir+'/offline-replay-failure.json',JSON.stringify({at:new Date().toISOString(),completed:results,error:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',completed:results.length,error:error instanceof Error?error.name:'UnknownError',field:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));
 process.exitCode=1;
}finally {globalThis.fetch=originalFetch;}
