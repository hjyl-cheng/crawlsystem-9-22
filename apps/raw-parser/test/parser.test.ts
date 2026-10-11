import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createFrozenFixture } from '@crawlsystem/contracts/fixtures';
import { contentHash } from '@crawlsystem/contracts/hash';
import { CONTRACT_VERSION, FrozenInputSchema, type PlanInput } from '@crawlsystem/contracts';
import { RawArchive, ArchiveError, type ObjectStore, type RawUnit } from '../../execution-worker/src/raw-archive.ts';
import { RawParser, ParseFailure, ResponseReplay } from '../src/parser.ts';

function memory() {
  const objects = new Map<string, Uint8Array>(); let gets = 0;
  const store: ObjectStore = { async get(key) { gets++; return objects.get(key) ?? null; },
    async put(key, bytes, _signal, absent) { if (absent && objects.has(key)) throw new ArchiveError('storage'); objects.set(key,bytes); } };
  return { store, objects, gets: () => gets };
}
function input(): PlanInput {
  const now = new Date().toISOString(), frozen = { ...createFrozenFixture(['ABOUT','VIDEO'], new Date(Date.now()+3_600_000).toISOString()), pipeline_version: 'r3.v1' as const };
  const id = randomUUID();
  return { plan: { plan_id:id,run_id:randomUUID(),workspace_id:'parser-test',channel_id:frozen.channel_id,source_revision:1,source_mode:'fixture',fixture_id:'channel-basic-v1',required_domains:frozen.required_domains,
    status:'RUNNING',version:1,execution_epoch:1,input_hash:contentHash(frozen),workflow_id:`m1/parser-test/${id}`,created_at:now,updated_at:now,finished_at:null,deadline_at:frozen.deadline_at,publication_status:'NOT_ENABLED' },
    input:frozen,domains:[],receipts:[] };
}
async function saved(context: PlanInput, store: ObjectStore) {
  const owner = { schema_version:CONTRACT_VERSION,workspace_id:context.plan.workspace_id,plan_id:context.plan.plan_id,execution_epoch:1,input_hash:context.plan.input_hash,workflow_id:context.plan.workflow_id };
  const unit: RawUnit = { schema_version:'crawl.unit.v1',owner,channel_id:context.plan.channel_id,step:'VIDEO-0',unit_id:'fixture:video:basic',captured_at:context.plan.created_at,
    responses:[{endpoint:'local:fixture',method:'LOCAL',status:200,captured_at:context.plan.created_at,body:'{}'}],result:{title:'An untrusted R2 projection',comments:['do not publish me']} };
  return new RawArchive(store,{async send(){}}).save(unit,new AbortController().signal);
}
test('independent parsing ignores the R2 projection and stores comment bodies before publishing references', async () => {
  const raw = memory(), parsed = memory(), plan = input(), ref = await saved(plan,raw.store);
  let calls = 0;
  const parser = new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async(_topic,_channel,fact)=>{
    calls++; assert.equal(fact.kind,'VIDEO');
    assert.ok(!JSON.stringify(fact).includes('固定样本评论')); assert.ok(!JSON.stringify(fact).includes('untrusted'));
    if (fact.kind !== 'VIDEO' || 'unavailable' in fact.payload) return assert.fail();
    assert.equal(fact.payload.title,'M1 固定样本视频'); assert.equal(fact.payload.comments_first_page,null);
    const commentRef=fact.payload.comments_ref!; const bytes=parsed.objects.get(commentRef.key)!;
    assert.equal(createHash('sha256').update(bytes).digest('hex'),commentRef.sha256);
    assert.equal(JSON.parse(gunzipSync(bytes).toString()).comments[0].text,'固定样本评论');
    assert.ok(parsed.objects.has(fact.parsed.key));
  }});
  await parser.parse(ref,new AbortController().signal); assert.equal(calls,1);
});
test('a lost facts notification retries the saved parse without fetching raw or duplicating comment objects', async () => {
  const raw=memory(),parsed=memory(),plan=input(),ref=await saved(plan,raw.store); let attempts=0;
  const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async()=>{if(++attempts===1)throw new Error('Kafka unavailable');}});
  await assert.rejects(parser.parse(ref,new AbortController().signal),/Kafka unavailable/);
  const objectCount=parsed.objects.size; await parser.parse(ref,new AbortController().signal);
  assert.equal(raw.gets(),1);assert.equal(parsed.objects.size,objectCount);assert.equal(attempts,2);
});
test('corrupt source bytes are rejected before any parsed object or Kafka fact exists', async () => {
  const raw=memory(),parsed=memory(),plan=input(),ref=await saved(plan,raw.store);
  raw.objects.set(ref.key,gzipSync('{}'));
  const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async()=>assert.fail('No corrupt publication')});
  await assert.rejects(parser.parse(ref,new AbortController().signal),e=>e instanceof ParseFailure&&e.code==='INTEGRITY'); assert.equal(parsed.objects.size,0);
});
test('offline replay rejects uncaptured endpoints instead of making a network request', async () => {
  const replay=new ResponseReplay([]);
  await assert.rejects(replay.fetch('https://www.youtube.com/youtubei/v1/player',{method:'POST'}),e=>e instanceof ParseFailure&&e.code==='REPLAY_INCOMPLETE');
});

test('a captured player whose next request was lost cannot consume the successful retry next response',async()=>{
  const raw=memory(),parsed=memory(),plan=input(),channel='UC'+'a'.repeat(22),video='abcdefghijk',at=plan.plan.created_at;
  const frozen=FrozenInputSchema.parse({schema_version:CONTRACT_VERSION,source_mode:'youtube',channel_id:channel,required_domains:['ABOUT','VIDEO'],scope:{video_limit:30,max_age_days:365,comments_per_video:0,comment_sort:'TOP_COMMENTS'},reference_time:at,deadline_at:plan.plan.deadline_at,max_attempts:3,pipeline_version:'r3.v1'});
  plan.input=frozen;Object.assign(plan.plan,{source_mode:'youtube',fixture_id:null,channel_id:channel,input_hash:contentHash(frozen)});
  const player={playabilityStatus:{status:'UNPLAYABLE'},videoDetails:{videoId:video,channelId:channel,title:'Transport retry fixture',shortDescription:'',lengthSeconds:'12',viewCount:'100',isLiveContent:false},
    microformat:{playerMicroformatRenderer:{publishDate:'2026-10-10T12:00:00Z',uploadDate:'2026-10-10T12:00:00Z',isShortsEligible:true,externalChannelId:channel,title:{simpleText:'Transport retry fixture'},description:{simpleText:''},lengthSeconds:'12',viewCount:'100'}}};
  const response=(path:string,body:unknown)=>({endpoint:'https://www.youtube.com/youtubei/v1/'+path,method:'POST',status:200,client:'WEB',captured_at:at,body:JSON.stringify(body)});
  const ref=await new RawArchive(raw.store,{async send(){}}).save({schema_version:'crawl.unit.v1',owner:{schema_version:CONTRACT_VERSION,workspace_id:plan.plan.workspace_id,plan_id:plan.plan.plan_id,execution_epoch:1,input_hash:plan.plan.input_hash,workflow_id:plan.plan.workflow_id},channel_id:channel,step:'VIDEO-0',unit_id:video,captured_at:at,
    responses:[response('player',{playabilityStatus:{status:'LOGIN_REQUIRED',reason:'Please sign in.'}}),response('player',player),response('next',{})],result:{title:'Do not trust this projection'}},new AbortController().signal);
  let published=0;const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async(_topic,_channel,fact)=>{
    assert.equal(fact.kind,'VIDEO');if(fact.kind!=='VIDEO'||'unavailable' in fact.payload)return assert.fail('Captured metadata remains usable');
    assert.equal(fact.payload.title,'Transport retry fixture');assert.equal(fact.payload.view_count.value,100);assert.equal(fact.payload.source_content_id,video);published++;
  }});
  await parser.parse(ref,new AbortController().signal);assert.equal(published,1);
});
