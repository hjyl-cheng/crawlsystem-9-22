import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {RequestTracing} from '../src/tracing.ts';
import {createServer} from '../src/index.ts';
import type {Store} from '@crawlsystem/store';

const traceId='1234567890abcdef1234567890abcdef',parentId='1234567890abcdef';
test('HTTP carries W3C context through success and failure without logging secrets',async()=>{
  const exporter=new InMemorySpanExporter(),tracing=new RequestTracing('test',()=>{},1,exporter);
  const app=createServer('control',{store:{pool:{query:async()=>({rows:[]})}} as unknown as Store,signingKey:randomBytes(48),tracing});
  app.get('/test/:id',async()=>({plan_id:'00000000-0000-4000-8000-000000000001',password:'secret-response'}));
  app.get('/error',async()=>{throw new Error('private database password');});
  try {
    const result=await app.inject({url:'/test/private-channel?secret=query',headers:{traceparent:`00-${traceId}-${parentId}-01`,authorization:'Bearer private-token',cookie:'secret-cookie'}});
    assert.equal(result.statusCode,200);assert.match(String(result.headers.traceparent),new RegExp(`^00-${traceId}-[a-f0-9]{16}-01$`));
    const failed=await app.inject({url:'/error',headers:{traceparent:result.headers.traceparent as string}});assert.equal(failed.statusCode,500);
    await tracing.flush();const spans=exporter.getFinishedSpans();assert.equal(spans.length,2);
    assert.equal(spans[0]!.parentSpanContext?.spanId,parentId);
    assert.equal(spans[1]!.parentSpanContext?.spanId,spans[0]!.spanContext().spanId);
    assert.equal(spans[0]!.attributes['business.plan_id'],'00000000-0000-4000-8000-000000000001');
    assert.equal(spans[1]!.status.code,2);
    const output=JSON.stringify(spans.map(s=>({name:s.name,attributes:s.attributes,status:s.status,events:s.events})));
    for(const secret of ['private-channel','secret=query','private-token','secret-cookie','secret-response','private database'])assert.ok(!output.includes(secret));
  } finally {await app.close();}
});
test('invalid parents are replaced and simultaneous requests keep independent trace identities',async()=>{
  const exporter=new InMemorySpanExporter(),tracing=new RequestTracing('test',()=>{},1,exporter);
  const app=createServer('ingest',{store:{} as Store,signingKey:randomBytes(48),tracing});
  try {
    const replies=await Promise.all(Array.from({length:8},(_,i)=>app.inject({url:'/healthz',headers:{traceparent:i%2?'garbage':`00-${'0'.repeat(32)}-${parentId}-01`}})));
    assert.equal(new Set(replies.map(r=>String(r.headers.traceparent).split('-')[1])).size,8);
    await tracing.flush();assert.equal(exporter.getFinishedSpans().length,8);
    for(const span of exporter.getFinishedSpans())assert.equal(span.parentSpanContext,undefined);
  } finally {await app.close();}
});
test('child spans continue a stored context and start a fresh trace without one',async()=>{
  const exporter=new InMemorySpanExporter(),tracing=new RequestTracing('test',()=>{},1,exporter);
  const continued=tracing.child(`00-${traceId}-${parentId}-01`,'activity executeFixture',{'business.plan_id':'p'});
  assert.match(continued.traceparent,new RegExp(`^00-${traceId}-[a-f0-9]{16}-01$`));continued.end();
  const fresh=tracing.child(undefined,'temporal start');assert.doesNotMatch(fresh.traceparent,new RegExp(traceId));fresh.end(true);
  await tracing.flush();const [a,b]=exporter.getFinishedSpans();
  assert.equal(a!.parentSpanContext?.spanId,parentId);assert.equal(b!.parentSpanContext,undefined);assert.equal(b!.status.code,2);
  await tracing.close();
});
