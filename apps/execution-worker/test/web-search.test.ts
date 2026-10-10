import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { QueryRunParamsSchema } from '@crawlsystem/contracts';
import { webSearchPages, embeddedObject,searchNavigation } from '../src/youtube/web-search.ts';
import { runOne } from '../src/query-runner.ts';
import type { ExecutionApi } from '@crawlsystem/execution-client/http';
const params=QueryRunParamsSchema.parse({text:'música',country:'BR',language:'pt',category:'Music',window:'THIS_YEAR',sort:'popularity',max_pages:2,continue_min_new:1,min_subscribers:1000,policy_version:'query-clock-2-about'});
const channel='UC1234567890123456789012';
const renderer={videoRenderer:{videoId:'12345678901',ownerText:{runs:[{navigationEndpoint:{browseEndpoint:{browseId:channel}}}]}}};
const initial={contents:{items:[renderer,{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'next'}}}}]}};
const html=`<script>var ytInitialData = ${JSON.stringify(initial)};</script><script>ytcfg.set(${JSON.stringify({INNERTUBE_API_KEY:'public-test-key',INNERTUBE_CLIENT_VERSION:'2.20261010.00.00',INNERTUBE_CONTEXT:{client:{hl:'pt',gl:'BR'}}})});</script>`;
test('search follows the legacy HTML filters and lazy continuation, never executing page scripts',async()=>{
  const calls:Request[]=[];
  const fetcher=(async(input,init)=>{const req=new Request(input,init);calls.push(req);return calls.length===1?new Response(html):Response.json({onResponseReceivedCommands:[{appendContinuationItemsAction:{continuationItems:[]}}]});}) as typeof fetch;
  const pages=webSearchPages(fetcher,params);
  assert.deepEqual((await pages.next()).value,{items:[{video_id:'12345678901',channel_id:channel}],more:true});
  assert.equal(calls.length,1,'no eager continuation request');
  const url=new URL(calls[0]!.url);assert.equal(url.pathname,'/results');assert.equal(url.searchParams.get('sp'),'CAMSBAgFEAE=');
  assert.deepEqual((await pages.next()).value,{items:[],more:false});
  assert.equal((await calls[1]!.json()).continuation,'next');
  assert.equal(new URL(calls[1]!.url).searchParams.get('key'),'public-test-key');
  assert.equal(calls[1]!.headers.get('x-youtube-client-version'),'2.20261010.00.00');
  assert.deepEqual(embeddedObject('ytInitialData = {"text":"brace } and \\\"","nested":{}}',['ytInitialData =']),{text:'brace } and "',nested:{}});
});
test('a malformed search response fails instead of reporting an empty successful search',async()=>{
  const pages=webSearchPages((async()=>new Response('<html>Sign in</html>')) as typeof fetch,params);
  await assert.rejects(()=>pages.next(),/missing/);
  assert.throws(()=>searchNavigation({contents:{videoRenderer:{videoId:'12345678901'}}}),/no readable channel/);
});
test('normal HTML ignores hidden challenge translations and bootstrap calls before JSON configuration',async()=>{
  const realShape=`<script>ytcfg.set(window.boot);</script><script>var messages={text:"before you continue to YouTube"};</script>${html}`;
  const pages=webSearchPages((async()=>new Response(realShape)) as typeof fetch,params);
  assert.equal((await pages.next()).value.items.length,1);
  const blocked=webSearchPages((async()=>new Response('<form id="captcha-form">Our systems have detected unusual traffic</form>')) as typeof fetch,params);
  await assert.rejects(()=>blocked.next(),/challenged/);
});
test('R4 run archives each raw page and completes identities without a Data API client or permit',async()=>{
  const pages:unknown[]=[],complete:unknown[]=[],objects:Uint8Array[]=[];
  const api={queryRunPage:async(_id:string,body:any)=>{pages.push(body);return {new_channel_ids:[channel],continue:false};},queryRunComplete:async(_id:string,body:any)=>{complete.push(body);return {new_channels:1,qualified_new:0,binding:{state:'BOOTSTRAP',cadence:null}};},queryRunFail:async()=>{assert.fail('should complete');}} as unknown as ExecutionApi;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(html)) as typeof fetch;
  try {
    await runOne({api,proxies:'direct',workerId:'test',workspaceId:'workspace',signal:new AbortController().signal,log:()=>{},searchStore:{get:async()=>null,put:async(_key,bytes)=>{objects.push(bytes);}}},
      {run_id:'11111111-1111-4111-8111-111111111111',binding_id:'22222222-2222-4222-8222-222222222222',attempt:1,lease_expires_at:new Date(Date.now()+60000).toISOString(),params});
  }finally{globalThis.fetch=original;}
  assert.equal(pages.length,1);assert.equal(objects.length,1);
  assert.equal(JSON.parse(gunzipSync(objects[0]!).toString()).responses[0].body,html);
  assert.deepEqual(complete[0],{attempt:1,pages:1,stop_reason:'low_yield',channels:[],missing_channel_ids:[]});
});
