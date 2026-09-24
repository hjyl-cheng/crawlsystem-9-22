import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { migrate } from '@crawlsystem/store/migrate';
import {prepareDatabase} from './database-ready.ts';
import { fixtureSubmission, submissionHash } from '@crawlsystem/contracts/hash';
import { isVideoUnavailable, ApiErrorSchema, ChannelDetailSchema, PlanDetailSchema, PlanSchema, ReceiptSchema, SessionSchema, WorkerSchema, type Domain, type Principal, type Submission, type WorkflowStarter } from '@crawlsystem/contracts';
import { issueToken } from '@crawlsystem/http/auth';
import { createControlApi } from '../../apps/control-api/src/app.ts';
import { createIngestApi } from '../../apps/ingest/src/app.ts';
import { IntentDispatcher } from '../../apps/control-api/src/dispatcher.ts';

const pool=createPool(),store=new Store(pool),key=randomBytes(48);
const control=createControlApi({store,signingKey:key,allowedOrigin:'http://127.0.0.1:18102'});
const ingest=createIngestApi({store,signingKey:key});
before(async()=>{await prepareDatabase(pool);await Promise.all([control.ready(),ingest.ready()]);});
after(async()=>{await Promise.all([control.close(),ingest.close()]);await pool.end();});
function identities() {
  const workspace_id=`test-${randomUUID()}`;
  return {operator:{workspace_id,subject:'operator',role:'operator'} as Principal,reader:{workspace_id,subject:'reader',role:'reader'} as Principal,worker:{workspace_id,subject:'worker',role:'worker'} as Principal};
}
async function setup(domains:Domain[]=['ABOUT','VIDEO']) {
  const people=identities();
  const request={request_id:randomUUID(),fixture_id:'channel-basic-v1' as const,required_domains:domains};
  const plan=await store.createPlan(people.operator,request);
  const input=await store.getInput(people.worker,plan.plan_id);
  return {...people,request,plan,input,about:fixtureSubmission(input,'ABOUT'),video:fixtureSubmission(input,'VIDEO')};
}
const auth=async(p:Principal)=>({authorization:`Bearer ${await issueToken(p,key)}`});
const rejectsCode=async(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,(e:unknown)=>e instanceof StoreError && e.code===code);
function rehash(s:Submission):Submission {return {...s,payload_hash:submissionHash(s)};}
async function count(table:'receipts'|'obligations'|'intents'|'plan_items',plan:string) {return (await pool.query(`SELECT count(*)::int AS n FROM m1.${table} WHERE plan_id=$1`,[plan])).rows[0].n as number;}

test('migration replay verifies checksum; actual transaction pool uses the isolated role',async()=>{
  await migrate(pool);
  const row=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  assert.match(row.db,/^crawlsystem_m1_.*_test$/);assert.notEqual(row.role,'postgres');
});
test('concurrent creation stores one frozen input and one start intent; conflicting identity fails',async()=>{
  const {operator}=identities();const input={request_id:randomUUID(),fixture_id:'channel-basic-v1' as const,required_domains:['ABOUT','VIDEO'] as Domain[]};
  const plans=await Promise.all(Array.from({length:8},()=>store.createPlan(operator,input)));
  assert.equal(new Set(plans.map(p=>p.plan_id)).size,1);assert.equal(await count('intents',plans[0]!.plan_id),1);
  await rejectsCode(()=>store.createPlan(operator,{...input,required_domains:['ABOUT']}),'CONFLICT');
});
test('eight concurrent identical submissions return one immutable durable receipt',async()=>{
  const t=await setup();const receipts=await Promise.all(Array.from({length:8},()=>store.apply(t.worker,t.about)));
  for(const receipt of receipts)assert.deepEqual(receipt,receipts[0]);
  assert.equal(await count('receipts',t.plan.plan_id),1);assert.equal(await count('obligations',t.plan.plan_id),0);
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).domains.find(d=>d.domain==='VIDEO')?.state,'PENDING');
  const changed=rehash({...t.about,domain_complete:false});
  await rejectsCode(()=>store.apply(t.worker,changed),'CONFLICT');
});
test('concurrent final domains close once; missing Agent remains pending and cannot publish',async()=>{
  const t=await setup();await Promise.all([store.apply(t.worker,t.about),store.apply(t.worker,t.video)]);
  assert.equal((await store.getPlan(t.reader,t.plan.plan_id)).plan.status,'COMPLETED');
  assert.equal(await count('obligations',t.plan.plan_id),1);assert.equal(await count('receipts',t.plan.plan_id),2);
  const channel=ChannelDetailSchema.parse(await store.getChannel(t.reader,t.plan.channel_id));
  const first=channel.videos[0];assert.ok(first&&!isVideoUnavailable(first));assert.equal(first.comments_first_page?.comments.length,1);assert.equal(channel.agent,null);
  const waiting=await setup(['ABOUT','VIDEO','AGENT']);await Promise.all([store.apply(waiting.worker,waiting.about),store.apply(waiting.worker,waiting.video)]);
  const context=await store.getInput(waiting.worker,waiting.plan.plan_id);
  assert.equal(context.plan.status,'WAITING');assert.equal(context.plan.publication_status,'NOT_ENABLED');
  assert.equal(context.domains.find(d=>d.domain==='AGENT')?.state,'PENDING');assert.equal(await count('obligations',waiting.plan.plan_id),0);
});
test('frozen target coverage and identity are enforced before sealing a domain',async()=>{
  const t=await setup();assert.equal(t.video.domain,'VIDEO');
  await rejectsCode(()=>store.apply(t.worker,rehash({...t.video,domain:'VIDEO',payload:{kind:'videos',items:[]}})),'DOMAIN_INCOMPLETE');
  assert.equal(await count('receipts',t.plan.plan_id),0);
  await rejectsCode(()=>store.apply(t.worker,rehash({...t.about,input_hash:'sha256:'+'a'.repeat(64)})),'INPUT_MISMATCH');
  if(t.about.domain!=='ABOUT')throw new Error('fixture');
  const about=t.about;
  await rejectsCode(()=>store.apply(t.worker,rehash({...about,payload:{...about.payload,channel_id:'outside'}})),'TARGET_MISMATCH');
  await rejectsCode(()=>store.apply(t.worker,{...t.about,payload_hash:'sha256:'+'b'.repeat(64)}),'CONFLICT');
});
test('an exception after receipt insertion rolls back facts, checkpoint and receipt together',async()=>{
  const t=await setup(['ABOUT']);const name=`test_fail_${randomBytes(8).toString('hex')}`;
  await pool.query(`CREATE FUNCTION m1.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${t.worker.workspace_id}' THEN RAISE EXCEPTION 'injected failure before commit'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON m1.receipts FOR EACH ROW EXECUTE FUNCTION m1.${name}()`);
  try {
    await assert.rejects(()=>store.apply(t.worker,t.about));
    assert.equal(await count('receipts',t.plan.plan_id),0);assert.equal(await count('plan_items',t.plan.plan_id),0);
    assert.equal((await store.getChannel(t.reader,t.plan.channel_id)).about,null);
  } finally {await pool.query(`DROP TRIGGER ${name} ON m1.receipts`);await pool.query(`DROP FUNCTION m1.${name}()`);}
  assert.equal((await store.apply(t.worker,t.about)).state,'APPLIED');
});
test('process death before COMMIT leaves no partial state and original submission recovers',async()=>{
  const t=await setup(['ABOUT']);
  const child=fork(fileURLToPath(new URL('./transaction-child.ts',import.meta.url)),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:process.env.M1_CRASH_DATABASE_URL ?? process.env.DATABASE_URL,M1_CRASH_PLAN:t.plan.plan_id,M1_CRASH_WORKSPACE:t.worker.workspace_id},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr?.on('data',d=>{stderr+=String(d);});
  const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('Crash fixture exited before transaction checkpoint: '+stderr);})]);
  assert.equal(ready[0],'receipt-written-before-commit');
  child.kill('SIGKILL');await once(child,'exit');
  assert.equal(await count('receipts',t.plan.plan_id),0);
  assert.equal((await store.apply(t.worker,t.about)).state,'APPLIED');
});
test('lost HTTP response after commit recovers the exact receipt using a new Store/pool',async()=>{
  const t=await setup(['ABOUT']);const app=createIngestApi({store,signingKey:key});
  app.addHook('onSend',async(request,reply,payload)=>{if(request.url==='/v1/submissions'){reply.hijack();reply.raw.destroy();}return payload;});
  const url=await app.listen({port:0,host:'127.0.0.1'});
  const headers={...await auth(t.worker),'content-type':'application/json'};
  try {await assert.rejects(()=>fetch(url+'/v1/submissions',{method:'POST',headers,body:JSON.stringify(t.about),signal:AbortSignal.timeout(5000)}));} finally {await app.close();}
  const recoveredPool=createPool();
  try {
    const recovered=new Store(recoveredPool),receipt=await recovered.getReceipt(t.worker,t.about.submission_id);
    assert.deepEqual(await recovered.apply(t.worker,t.about),receipt);
    assert.equal((await recovered.getInput(t.worker,t.plan.plan_id)).plan.status,'COMPLETED');
    assert.equal(await count('receipts',t.plan.plan_id),1);assert.equal(await count('obligations',t.plan.plan_id),1);
  } finally {await recoveredPool.end();}
});

test('cancellation is version checked and idempotent; previous receipts stay readable',async()=>{
  const t=await setup();const receipt=await store.apply(t.worker,t.about);
  await rejectsCode(()=>store.cancel(t.operator,t.plan.plan_id,{command_id:randomUUID(),expected_version:t.plan.version}),'CONFLICT');
  const current=(await store.getInput(t.worker,t.plan.plan_id)).plan;
  const cmd={command_id:randomUUID(),expected_version:current.version};
  const cancelled=await store.cancel(t.operator,t.plan.plan_id,cmd);
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.execution_epoch,current.execution_epoch+1);
  assert.deepEqual(await store.cancel(t.operator,t.plan.plan_id,cmd),cancelled);
  assert.deepEqual(await store.apply(t.worker,t.about),receipt);
  await rejectsCode(()=>store.apply(t.worker,t.video),'STALE_EXECUTION');
  assert.equal(await count('obligations',t.plan.plan_id),0);
});
test('cancel versus final submission serializes into one legal outcome',async()=>{
  const t=await setup(['ABOUT']);
  const outcomes=await Promise.allSettled([store.apply(t.worker,t.about),store.cancel(t.operator,t.plan.plan_id,{command_id:randomUUID(),expected_version:t.plan.version})]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const p=(await store.getInput(t.worker,t.plan.plan_id)).plan;
  assert.ok(['CANCELLED','COMPLETED'].includes(p.status));assert.equal(await count('receipts',p.plan_id),p.status==='COMPLETED'?1:0);
});
test('older plans cannot overwrite newer Current while retaining their own proofs',async()=>{
  const t=await setup();const newer=await store.createPlan(t.operator,{...t.request,request_id:randomUUID()});
  const context=await store.getInput(t.worker,newer.plan_id);
  await store.apply(t.worker,fixtureSubmission(context,'ABOUT'));await store.apply(t.worker,fixtureSubmission(context,'VIDEO'));
  await store.apply(t.worker,t.about);await store.apply(t.worker,t.video);
  const row=(await pool.query('SELECT about_revision,latest_plan_id FROM m1.channels WHERE workspace_id=$1',[t.worker.workspace_id])).rows[0];
  assert.equal(Number(row.about_revision),newer.source_revision);assert.equal(row.latest_plan_id,newer.plan_id);
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).plan.status,'COMPLETED');
});
test('HTTP authentication, roles, cross-workspace reads and input limits are enforced',async()=>{
  const t=await setup();
  let r=await control.inject({url:'/v1/plans'});assert.equal(r.statusCode,401);ApiErrorSchema.parse(r.json());
  r=await control.inject({url:'/v1/session',headers:await auth(t.reader)});SessionSchema.parse(r.json());
  r=await control.inject({method:'POST',url:'/v1/plans',headers:await auth(t.reader),payload:t.request});assert.equal(r.statusCode,403);
  r=await control.inject({url:`/v1/plans/${t.plan.plan_id}`,headers:await auth(identities().reader)});assert.equal(r.statusCode,404);
  r=await ingest.inject({method:'POST',url:'/v1/submissions',headers:await auth(t.operator),payload:t.about});assert.equal(r.statusCode,403);
  r=await control.inject({url:'/v1/plans?limit=1000',headers:await auth(t.reader)});assert.equal(r.statusCode,400);
  r=await control.inject({url:'/v1/plans?cursor=100001',headers:await auth(t.reader)});assert.equal(r.statusCode,400);
  r=await control.inject({method:'POST',url:'/v1/plans',headers:{...await auth(t.operator),'content-type':'application/json'},payload:'x'.repeat(1048577)});assert.equal(r.statusCode,413);
  r=await control.inject({url:'/v1/session',headers:{...await auth(t.reader),origin:'https://untrusted.invalid'}});assert.equal(r.statusCode,403);
});
test('all console query endpoints return actual persisted objects with the published schemas',async()=>{
  const t=await setup();const h=await auth(t.operator),w=await auth(t.worker);
  const create=await control.inject({method:'POST',url:'/v1/plans',headers:h,payload:t.request});PlanSchema.parse(create.json());assert.equal(create.json().plan_id,t.plan.plan_id);
  const post=await ingest.inject({method:'POST',url:'/v1/submissions',headers:w,payload:t.about});assert.equal(post.statusCode,200);ReceiptSchema.parse(post.json());
  const receipt=await control.inject({url:`/v1/receipts/${t.about.submission_id}`,headers:h});assert.deepEqual(receipt.json(),post.json());
  const detail=await control.inject({url:`/v1/plans/${t.plan.plan_id}`,headers:h});PlanDetailSchema.parse(detail.json());
  const event={event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'fixture',kind:'ERROR',domain:null,message:'Sample diagnostic',error_code:'UNAVAILABLE'};
  assert.equal((await control.inject({method:'POST',url:`/v1/plans/${t.plan.plan_id}/events`,headers:w,payload:event})).statusCode,200);
  const heartbeat=await control.inject({method:'POST',url:'/v1/workers/heartbeat',headers:w,payload:{worker_id:'worker',server_id:'a1-test',build_version:'test',accepting_work:true,capacity:1,running_plan_ids:[t.plan.plan_id]}});WorkerSchema.parse(heartbeat.json());
  // Fixture plans appear in business lists only on request (source_mode=fixture).
  for(const path of ['plans?source_mode=fixture&','channels?source_mode=fixture&','workers?','errors?source_mode=fixture&']) {
    const r=await control.inject({url:`/v1/${path}limit=1`,headers:h});assert.equal(r.statusCode,200);assert.equal(r.json().items.length,1);
  }
  const channel=await control.inject({url:`/v1/channels/${encodeURIComponent(t.plan.channel_id)}`,headers:h});ChannelDetailSchema.parse(channel.json());
  await pool.query("UPDATE m1.workers SET last_heartbeat_at=clock_timestamp()-interval '91 seconds' WHERE workspace_id=$1",[t.worker.workspace_id]);
  assert.equal((await store.listWorkers(t.reader)).items[0]?.stale,true);
});
test('failed receipt queries report retryable unavailability, never a missing receipt',async()=>{
  const t=await setup();const url=new URL(process.env.DATABASE_URL!);url.hostname='127.0.0.1';url.port='1';
  const unavailable=createPool({...process.env,DATABASE_URL:url.toString()});
  const app=createControlApi({store:new Store(unavailable),signingKey:key});
  try {
    const response=await app.inject({url:`/v1/receipts/${randomUUID()}`,headers:await auth(t.worker)});
    assert.equal(response.statusCode,503);const body=ApiErrorSchema.parse(response.json());
    assert.equal(body.error.code,'UNAVAILABLE');assert.equal(body.error.retryable,true);
    assert.ok(response.headers['x-request-id']);assert.equal(response.headers['x-request-id'],body.error.correlation_id);
  } finally {await app.close();await unavailable.end();}
});
test('diagnostic failure closes only active plans; deadlines are durable and swept once',async()=>{
  const t=await setup();await store.event(t.worker,t.plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'fixture',kind:'FAILED',domain:null,message:'Retry budget exhausted',error_code:'BUDGET_EXHAUSTED'});
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).plan.status,'FAILED');
  await rejectsCode(()=>store.apply(t.worker,t.about),'STALE_EXECUTION');
  const expired=await setup();await pool.query("UPDATE m1.plans SET deadline_at=clock_timestamp()-interval '1 second' WHERE plan_id=$1",[expired.plan.plan_id]);
  assert.equal(await store.expirePlans(20,expired.worker.workspace_id),1);assert.equal(await store.expirePlans(20,expired.worker.workspace_id),0);
  assert.equal((await store.getInput(expired.worker,expired.plan.plan_id)).plan.status,'FAILED');
  assert.equal((await store.listErrors(expired.reader,20,0,'fixture')).items[0]?.error_code,'BUDGET_EXHAUSTED');
});
test('durable start survives dispatcher restart and lost acknowledgement using stable identity',async()=>{
  const t=await setup();const started=new Map<string,string>();let calls=0;
  const starter:WorkflowStarter={start:async input=>{calls++;const run=started.get(input.workflow_id) ?? randomUUID();started.set(input.workflow_id,run);if(calls===1)throw new Error('ack lost');return {workflow_id:input.workflow_id,run_id:run};},cancel:async()=>{}};
  await new IntentDispatcher(store,starter,t.worker.workspace_id).tick();
  assert.equal(started.size,1);assert.equal((await pool.query('SELECT state FROM m1.intents WHERE plan_id=$1',[t.plan.plan_id])).rows[0].state,'PENDING');
  await pool.query('UPDATE m1.intents SET available_at=clock_timestamp() WHERE plan_id=$1',[t.plan.plan_id]);
  await new IntentDispatcher(new Store(pool),starter,t.worker.workspace_id).tick();
  assert.equal(calls,2);assert.equal(started.size,1);assert.equal((await pool.query('SELECT state FROM m1.intents WHERE plan_id=$1',[t.plan.plan_id])).rows[0].state,'DONE');
});
test('business metrics use committed facts in the configured workspace and bounded labels',async()=>{
  const t=await setup();await store.apply(t.worker,t.about);
  const app=createControlApi({store,signingKey:key,metricsWorkspace:t.worker.workspace_id});
  try {
    await app.inject({url:'/v1/session',headers:await auth(t.reader)});
    const response=await app.inject({url:'/metrics'});assert.equal(response.statusCode,200);
    assert.match(response.body,/m1_plans\{state="RUNNING"\} 1/);
    assert.match(response.body,/m1_domains\{state="ABOUT_APPLIED"\} 1/);
    assert.match(response.body,/m1_domains\{state="VIDEO_PENDING"\} 1/);
    assert.match(response.body,/m1_receipts\{state="APPLIED"\} 1/);
    assert.match(response.body,/m1_http_request_duration_seconds_bucket/);
    assert.ok(!response.body.includes(t.plan.plan_id));assert.ok(!response.body.includes(t.worker.workspace_id));
  } finally {await app.close();}
});
test('expired leases can be claimed; stale claimants cannot overwrite newer acknowledgement',async()=>{
  const t=await setup();const first=await store.claimIntent(30,t.worker.workspace_id);assert.ok(first);
  await pool.query("UPDATE m1.intents SET lease_until=clock_timestamp()-interval '1 second' WHERE intent_id=$1",[first.intent_id]);
  const second=await store.claimIntent(30,t.worker.workspace_id);assert.ok(second);assert.notEqual(first.lease_token,second.lease_token);
  await store.finishIntent(second,'DONE','current-run');await store.finishIntent(first,'DONE','stale-run');
  assert.equal((await pool.query('SELECT workflow_run_id FROM m1.intents WHERE intent_id=$1',[first.intent_id])).rows[0].workflow_run_id,'current-run');
});
test('cancel during a claimed start waits for startup resolution and retries cancellation durably',async()=>{
  const t=await setup();const claimed=await store.claimIntent(30,t.worker.workspace_id);assert.ok(claimed);
  await store.cancel(t.operator,t.plan.plan_id,{command_id:randomUUID(),expected_version:1});
  assert.equal(await store.claimIntent(30,t.worker.workspace_id),null);
  await store.finishIntent(claimed,'DONE','run-started');let cancels=0;
  const starter:WorkflowStarter={start:async()=>{throw new Error('must not start');},cancel:async id=>{assert.equal(id,t.plan.workflow_id);if(++cancels===1)throw new Error('ack lost');}};
  await new IntentDispatcher(store,starter,t.worker.workspace_id).tick();
  await pool.query("UPDATE m1.intents SET available_at=clock_timestamp() WHERE plan_id=$1 AND kind='CANCEL'",[t.plan.plan_id]);
  await new IntentDispatcher(store,starter,t.worker.workspace_id).tick();assert.equal(cancels,2);
  assert.equal((await pool.query("SELECT state FROM m1.intents WHERE plan_id=$1 AND kind='CANCEL'",[t.plan.plan_id])).rows[0].state,'DONE');
});
test('cancel, expiry and failure before first dispatch settle without cancelling a nonexistent Workflow',async()=>{
  for (const reason of ['cancel','expiry','failure'] as const) {
    const t=await setup();let rpcCalls=0;
    const starter:WorkflowStarter={start:async()=>{rpcCalls++;throw new Error('unexpected start');},cancel:async()=>{rpcCalls++;throw new Error('Workflow does not exist');}};
    if(reason==='cancel')await store.cancel(t.operator,t.plan.plan_id,{command_id:randomUUID(),expected_version:1});
    if(reason==='expiry')await pool.query("UPDATE m1.plans SET deadline_at=clock_timestamp()-interval '1 second' WHERE plan_id=$1",[t.plan.plan_id]);
    if(reason==='failure')await store.event(t.worker,t.plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'INPUT',kind:'FAILED',domain:null,message:'Input unavailable',error_code:'INPUT_MISMATCH'});
    const dispatcher=new IntentDispatcher(store,starter,t.worker.workspace_id);
    assert.equal(await dispatcher.tick(),true,reason);
    assert.equal(await dispatcher.tick(),false,reason);
    assert.equal(rpcCalls,0,reason);
    const intents=(await pool.query('SELECT kind,state FROM m1.intents WHERE plan_id=$1 ORDER BY kind',[t.plan.plan_id])).rows;
    assert.deepEqual(intents,[{kind:'CANCEL',state:'SKIPPED'},{kind:'START',state:'SKIPPED'}],reason);
    assert.equal((await store.getInput(t.worker,t.plan.plan_id)).plan.status,reason==='cancel'?'CANCELLED':'FAILED');
    await rejectsCode(()=>store.apply(t.worker,t.about),'STALE_EXECUTION');
  }
});
test('an unacknowledged START must still be cancelled after its pending retry is skipped',async()=>{
  const t=await setup();let starts=0,cancels=0;
  const starter:WorkflowStarter={start:async()=>{starts++;throw new Error('start committed but acknowledgement lost');},cancel:async id=>{assert.equal(id,t.plan.workflow_id);cancels++;}};
  const dispatcher=new IntentDispatcher(store,starter,t.worker.workspace_id);
  await dispatcher.tick();
  await store.cancel(t.operator,t.plan.plan_id,{command_id:randomUUID(),expected_version:1});
  await dispatcher.tick();
  assert.equal(starts,1);assert.equal(cancels,1);
  assert.equal((await pool.query("SELECT state FROM m1.intents WHERE plan_id=$1 AND kind='CANCEL'",[t.plan.plan_id])).rows[0].state,'DONE');
});
test('the creating request trace continues through the durable intent, dispatch span and Worker input',async()=>{
  const {InMemorySpanExporter}=await import('@opentelemetry/sdk-trace-base');
  const {RequestTracing}=await import('@crawlsystem/http/tracing');
  const people=identities(),traceId='0af7651916cd43dd8448eb211c80319c';
  const created=await control.inject({method:'POST',url:'/v1/plans',headers:{...await auth(people.operator),traceparent:`00-${traceId}-b7ad6b7169203331-01`},payload:{request_id:randomUUID(),fixture_id:'channel-basic-v1'}});
  assert.equal(created.statusCode,200);const plan=PlanSchema.parse(created.json());
  const stored=(await store.getInput(people.worker,plan.plan_id)).trace_context!;
  assert.equal(stored,created.headers.traceparent,'the Control server span is the parent of later execution work');
  assert.match(stored,new RegExp(`^00-${traceId}-`));
  const exporter=new InMemorySpanExporter(),tracing=new RequestTracing('dispatcher-test',()=>{},0,exporter);
  const starter:WorkflowStarter={start:async input=>({workflow_id:input.workflow_id,run_id:randomUUID()}),cancel:async()=>{}};
  assert.equal(await new IntentDispatcher(store,starter,people.worker.workspace_id,tracing).tick(),true);
  await tracing.flush();
  const [span]=exporter.getFinishedSpans();
  assert.equal(span?.name,'temporal start');assert.equal(span?.spanContext().traceId,traceId,'sampled by the parent even at root ratio 0');
  assert.equal(span?.parentSpanContext?.spanId,stored.split('-')[2]);
  // Invalid client context is not stored and never blocks creation.
  const other=await store.createPlan(people.operator,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']},'not-a-traceparent');
  assert.equal((await store.getInput(people.worker,other.plan_id)).trace_context,undefined);
  await tracing.close();
});
