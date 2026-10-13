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
test('offline removal parsing requires both captured sources and ignores an untrusted removal projection',async()=>{
 const context=input(),channel='UC1234567890123456789012',raw=memory(),parsed=memory();
 const frozen=FrozenInputSchema.parse({schema_version:CONTRACT_VERSION,source_mode:'youtube',pipeline_version:'r3.v1',channel_id:channel,required_domains:['ABOUT'],scope:{video_limit:30,max_age_days:90,comments_per_video:0,comment_sort:'TOP_COMMENTS'},reference_time:context.plan.created_at,deadline_at:context.plan.deadline_at,max_attempts:3});
 context.input=frozen;context.plan={...context.plan,channel_id:channel,source_mode:'youtube',fixture_id:null,required_domains:['ABOUT'],input_hash:contentHash(frozen)};
 const owner={schema_version:CONTRACT_VERSION,workspace_id:context.plan.workspace_id,plan_id:context.plan.plan_id,execution_epoch:1,input_hash:context.plan.input_hash,workflow_id:context.plan.workflow_id};
 const unit:RawUnit={schema_version:'crawl.unit.v1',owner,channel_id:channel,step:'ABOUT',unit_id:'channel',captured_at:context.plan.created_at,result:{reason:'source_removed'},responses:[
  {endpoint:'https://www.youtube.com/youtubei/v1/browse',method:'POST',status:200,captured_at:context.plan.created_at,body:JSON.stringify({alerts:[{alertRenderer:{text:{simpleText:'This channel is not available.'}}}]})},
  {endpoint:'https://www.googleapis.com/youtube/v3/channels',method:'GET',status:200,captured_at:context.plan.created_at,body:'{"items":[]}'}]};
 const ref=await new RawArchive(raw.store,{async send(){}}).save(unit,new AbortController().signal);let published=0;
 const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>context,publish:async(topic,_id,fact)=>{assert.equal(topic,'facts.channel');assert.equal(fact.kind,'CHANNEL_REMOVED');published++;}});
 assert.equal((await parser.parse(ref,new AbortController().signal))!.kind,'CHANNEL_REMOVED');assert.equal(published,1);
 const incomplete=memory(),untrusted={...unit,owner:{...owner,plan_id:randomUUID()},responses:unit.responses.slice(0,1)};
 context.plan.plan_id=untrusted.owner.plan_id;context.plan.workflow_id=untrusted.owner.workflow_id;
 const missing=await new RawArchive(incomplete.store,{async send(){}}).save(untrusted,new AbortController().signal);
 await assert.rejects(()=>new RawParser({raw:incomplete.store,parsed:memory().store,loadPlan:async()=>context,publish:async()=>{throw new Error('must not publish');}}).parse(missing,new AbortController().signal));
});
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

for(const kind of ['UPDATE','FULL'] as const) test(`offline ${kind} target replay merges frozen recovery with captured discovery, ignoring the Worker projection`, async () => {
  const raw = memory(), parsed = memory(), plan = input(), channel = 'UC' + 'a'.repeat(22), at = plan.plan.created_at;
  const frozen = FrozenInputSchema.parse({ schema_version: CONTRACT_VERSION, source_mode: 'youtube', pipeline_version: 'r3.v1',
    channel_id: channel, ...(kind==='UPDATE'?{plan_kind:'UPDATE',discovery_anchor_ids:['anchor00001']} : {}), required_domains: ['VIDEO'], recovery_video_ids: ['missing0001', 'newvideo001'],
    scope: { video_limit: 30, max_age_days: 90, comments_per_video: 0, comment_sort: 'TOP_COMMENTS' }, reference_time: at, deadline_at: plan.plan.deadline_at, max_attempts: 3 });
  plan.input = frozen; Object.assign(plan.plan, { source_mode: 'youtube', fixture_id: null, channel_id: channel, input_hash: contentHash(frozen), required_domains: ['VIDEO'] });
  const contents = ['newvideo001', 'anchor00001', 'ignored0001'].map(videoId => ({ playlistVideoRenderer: { videoId, title: { simpleText: videoId,
    accessibility: { accessibilityData: { label: videoId } } }, thumbnail: { thumbnails: [] }, navigationEndpoint: { watchEndpoint: { videoId } }, isPlayable: true } }));
  const captured = { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents } }] } }] }
  } } }] } } };
  const unit: RawUnit = { schema_version: 'crawl.unit.v1', owner: { schema_version: CONTRACT_VERSION, workspace_id: plan.plan.workspace_id,
    plan_id: plan.plan.plan_id, execution_epoch: 1, input_hash: plan.plan.input_hash, workflow_id: plan.plan.workflow_id }, channel_id: channel,
    step: 'TARGETS', unit_id: 'uploads', captured_at: at, result: { ids: ['untrusted01'] }, responses: [{ endpoint: 'https://www.youtube.com/youtubei/v1/browse',
      method: 'POST', status: 200, captured_at: at, body: JSON.stringify(captured) }] };
  const ref = await new RawArchive(raw.store, { async send() {} }).save(unit, new AbortController().signal);
  const fact = await new RawParser({ raw: raw.store, parsed: parsed.store, loadPlan: async () => plan, publish: async () => {} }).parse(ref, new AbortController().signal);
  assert.equal(fact!.kind, 'TARGETS'); if (fact!.kind !== 'TARGETS') return;
  assert.deepEqual(fact!.payload.video_ids, kind==='UPDATE'?['missing0001', 'newvideo001']:['missing0001','newvideo001','anchor00001','ignored0001']);
  assert.equal(fact!.payload.kind, kind==='UPDATE'?'discovery':'targets'); if (fact!.payload.kind === 'discovery') assert.equal(fact!.payload.matched_anchor_id, 'anchor00001');
});

for (const scenario of ['lost-next','http-403','next-before-player','late-player'] as const) test(`offline video replay selects the successful capture after ${scenario}`,async()=>{
  const raw=memory(),parsed=memory(),plan=input(),channel='UC'+'a'.repeat(22),video='abcdefghijk',at=plan.plan.created_at;
  const frozen=FrozenInputSchema.parse({schema_version:CONTRACT_VERSION,source_mode:'youtube',channel_id:channel,required_domains:['ABOUT','VIDEO'],scope:{video_limit:30,max_age_days:365,comments_per_video:0,comment_sort:'TOP_COMMENTS'},reference_time:at,deadline_at:plan.plan.deadline_at,max_attempts:3,pipeline_version:'r3.v1'});
  plan.input=frozen;Object.assign(plan.plan,{source_mode:'youtube',fixture_id:null,channel_id:channel,input_hash:contentHash(frozen)});
  const player={playabilityStatus:{status:'UNPLAYABLE'},videoDetails:{videoId:video,channelId:channel,title:'Transport retry fixture',shortDescription:'',lengthSeconds:'12',viewCount:'100',isLiveContent:false},
    microformat:{playerMicroformatRenderer:{publishDate:'2026-10-10T12:00:00Z',uploadDate:'2026-10-10T12:00:00Z',isShortsEligible:true,externalChannelId:channel,title:{simpleText:'Transport retry fixture'},description:{simpleText:''},lengthSeconds:'12',viewCount:'100'}}};
  const response=(path:string,body:unknown,status=200)=>({endpoint:'https://www.youtube.com/youtubei/v1/'+path,method:'POST',status,client:'WEB',captured_at:at,body:JSON.stringify(body)});
  const ref=await new RawArchive(raw.store,{async send(){}}).save({schema_version:'crawl.unit.v1',owner:{schema_version:CONTRACT_VERSION,workspace_id:plan.plan.workspace_id,plan_id:plan.plan.plan_id,execution_epoch:1,input_hash:plan.plan.input_hash,workflow_id:plan.plan.workflow_id},channel_id:channel,step:'VIDEO-0',unit_id:video,captured_at:at,
    responses:[response('player',{playabilityStatus:{status:'LOGIN_REQUIRED',reason:'Please sign in.'}}),...(scenario==='http-403'?[response('next',{},403)]:[]),
      ...(scenario==='late-player'?[response('player',{...player,videoDetails:{...player.videoDetails,viewCount:'99'}})]:[]),
      ...(scenario==='next-before-player'?[response('next',{}),response('player',player)]:[response('player',player),response('next',{})])],
    result:{title:'Do not trust this projection'}},new AbortController().signal);
  let published=0;const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async(_topic,_channel,fact)=>{
    assert.equal(fact.kind,'VIDEO');if(fact.kind!=='VIDEO'||'unavailable' in fact.payload)return assert.fail('Captured metadata remains usable');
    assert.equal(fact.payload.title,'Transport retry fixture');assert.equal(fact.payload.view_count.value,100);assert.equal(fact.payload.source_content_id,video);published++;
  }});
  await parser.parse(ref,new AbortController().signal);assert.equal(published,1);
});

test('an API fallback cannot publish a playlist-associated video owned by another channel', async () => {
  const raw=memory(),parsed=memory(),plan=input(),channel='UC'+'a'.repeat(22),video='foreign0001',at=plan.plan.created_at;
  const frozen=FrozenInputSchema.parse({schema_version:CONTRACT_VERSION,source_mode:'youtube',channel_id:channel,required_domains:['VIDEO'],
    scope:{video_limit:30,max_age_days:90,comments_per_video:0,comment_sort:'TOP_COMMENTS'},reference_time:at,deadline_at:plan.plan.deadline_at,max_attempts:3,pipeline_version:'r3.v1'});
  plan.input=frozen;Object.assign(plan.plan,{source_mode:'youtube',fixture_id:null,channel_id:channel,input_hash:contentHash(frozen),required_domains:['VIDEO']});
  const ref=await new RawArchive(raw.store,{async send(){}}).save({schema_version:'crawl.unit.v1',
    owner:{schema_version:CONTRACT_VERSION,workspace_id:plan.plan.workspace_id,plan_id:plan.plan.plan_id,execution_epoch:1,input_hash:plan.plan.input_hash,workflow_id:plan.plan.workflow_id},
    channel_id:channel,step:'VIDEO-0',unit_id:video,captured_at:at,result:{channel_id:channel},
    responses:[{endpoint:'https://www.googleapis.com/youtube/v3/videos',method:'GET',status:200,captured_at:at,
      body:JSON.stringify({items:[{id:video,snippet:{channelId:'UC'+'b'.repeat(22)}}]})}]},new AbortController().signal);
  const parser=new RawParser({raw:raw.store,parsed:parsed.store,loadPlan:async()=>plan,publish:async()=>assert.fail('Foreign owner must not be published')});
  await assert.rejects(parser.parse(ref,new AbortController().signal),error=>error instanceof ParseFailure&&error.code==='INVALID_FACT');
  assert.equal(parsed.objects.size,0);
});
