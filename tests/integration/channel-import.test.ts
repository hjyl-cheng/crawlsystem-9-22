import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store, StoreError } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, UpdateLimitsSchema, type Domain, type Plan, type Principal, type Submission, type YoutubeFrozenInput } from '@crawlsystem/contracts';
import { fixtureChannel, fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId, submissionHash } from '@crawlsystem/contracts/hash';
import { prepareDatabase } from './database-ready.ts';

/** Plan step B1: channels imported in bulk are queued, then admitted into first collections under the scheduler's limits. */
const pool = createPool();
before(async () => { await prepareDatabase(pool); });
after(async () => { await pool.end(); });
const model = JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json', import.meta.url), 'utf8'));
/** A workspace whose one Worker reports `slots` free plan slots; first collections are admitted only into them. */
async function setup(limits = {}, slots = 2) {
  const workspace_id = `test-import-${randomUUID()}`;
  const as = (role: Principal['role']): Principal => ({ workspace_id, subject: role, role });
  const t = { store: new Store(pool, UpdateLimitsSchema.parse(limits)), op: as('operator'), reader: as('reader'), worker: as('worker') };
  await t.store.heartbeat(t.worker, { worker_id: t.worker.subject, server_id: 'test-node', build_version: 'test', accepting_work: true, capacity: slots, running_plan_ids: [] });
  return t;
}
const channelId = () => 'UC' + randomUUID().replaceAll('-', '').slice(0, 22);
function submit(plan: Plan, domain: Domain, key: string, payload: unknown, domain_complete: boolean): Submission {
  const body = { schema_version: CONTRACT_VERSION, submission_id: stableSubmissionId(plan.plan_id, plan.execution_epoch, domain, key), plan_id: plan.plan_id,
    execution_epoch: plan.execution_epoch, input_hash: plan.input_hash, logical_batch_key: key, domain, payload, domain_complete };
  return { ...body, payload_hash: submissionHash(body as never) } as Submission;
}
const importLines = (t: Awaited<ReturnType<typeof setup>>, lines: string[]) => t.store.importChannels(t.op, { request_id: randomUUID(), lines });
const applyAbout = (t: Awaited<ReturnType<typeof setup>>, plan: Plan) => t.store.apply(t.worker, submit(plan, 'ABOUT', 'about',
  { ...structuredClone(fixtureChannel), channel_id: plan.channel_id, channel_url: `https://www.youtube.com/channel/${plan.channel_id}`, observed_at: new Date().toISOString() }, true));
async function completeFirstCollection(t: Awaited<ReturnType<typeof setup>>, plan: Plan) {
  const channel = plan.channel_id, input = (await t.store.getInput(t.worker, plan.plan_id)).input as YoutubeFrozenInput, video = randomUUID().replaceAll('-', '').slice(0, 11);
  await applyAbout(t, plan);
  await t.store.apply(t.worker, submit(plan, 'VIDEO', 'targets', { kind: 'targets', channel_id: channel, video_ids: [video], listed_at: new Date().toISOString(),
    window_start: new Date(Date.parse(input.reference_time) - input.scope.max_age_days * 86_400_000).toISOString(), exhausted: true, source: 'test' }, false));
  await t.store.apply(t.worker, submit(plan, 'VIDEO', 'videos', { kind: 'videos', items: [{ ...structuredClone(fixtureVideo), channel_id: channel, source_content_id: video, url: `https://www.youtube.com/watch?v=${video}` }] }, true));
  const snapshot = await t.store.agentInput(t.worker, plan.plan_id), { diagnostics: _diagnostics, ...profile } = model;
  await t.store.apply(t.worker, submit(plan, 'AGENT', 'agent', { channel_id: channel, input_hash: snapshot.input_hash, ...profile }, true));
}

test('each pasted line is queued once, or reported as known, repeated, a handle or unreadable', async () => {
  const t = await setup(), a = channelId(), b = channelId();
  const result = await importLines(t, [a, `https://www.youtube.com/channel/${a}/videos`, ` ${b} `, '@somecreator', 'https://www.youtube.com/@another', 'not a channel', 'https://example.com/channel/' + a, '']);
  assert.deepEqual(result.items.map(i => i.outcome), ['queued', 'duplicate', 'queued', 'handle_unsupported', 'handle_unsupported', 'invalid', 'invalid']);
  assert.equal(result.queued, 2);
  assert.deepEqual((await importLines(t, [a])).items.map(i => i.outcome), ['already_queued']);
  const imports = await t.store.channelImports(t.reader);
  assert.deepEqual(imports.counts, { queued: 2, planned: 0, done: 0, failed: 0, rejected:0 });
  await assert.rejects(() => t.store.importChannels(t.reader, { request_id: randomUUID(), lines: [a] }), (e: unknown) => e instanceof StoreError && e.code === 'FORBIDDEN');
});

test('the scheduler admits imports oldest first into free Worker slots; outcomes follow the first collection', async () => {
  const t = await setup({}, 1), first = channelId(), second = channelId();
  await importLines(t, [first]); await importLines(t, [second]);
  const admitted = await t.store.scheduleUpdates(t.op.workspace_id);
  assert.deepEqual(admitted.map(p => [p.channel_id, p.plan_kind, p.required_domains]), [[first, 'FULL', ['ABOUT', 'VIDEO', 'AGENT']]], 'one at a time, oldest first');
  assert.deepEqual((await t.store.channelImports(t.reader)).counts, { queued: 1, planned: 1, done: 0, failed: 0, rejected:0 });
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id), [], 'the only slot is taken');

  // The first collection stops after the About page: the channel is known but not managed.
  await applyAbout(t, admitted[0]!);
  const half = (await t.store.getPlan(t.reader, admitted[0]!.plan_id)).plan;
  await t.store.cancel(t.op, half.plan_id, { command_id: randomUUID(), expected_version: half.version });
  assert.equal((await t.store.channelImports(t.reader)).items.find(i => i.channel_id === first)!.state, 'failed');
  assert.equal((await t.store.getChannel(t.reader, first)).management.state, null);
  assert.deepEqual((await importLines(t, [first])).items.map(i => i.outcome), ['queued'], 'a half-collected channel whose import failed can be queued again');

  const next = await t.store.scheduleUpdates(t.op.workspace_id);
  assert.deepEqual(next.map(p => p.channel_id), [second], 'the older queued channel goes first');
  await completeFirstCollection(t, next[0]!);
  const done = (await t.store.channelImports(t.reader)).items.find(i => i.channel_id === second)!;
  assert.equal(done.state, 'done'); assert.equal(done.title, fixtureChannel.title);
  assert.equal((await t.store.getChannel(t.reader, second)).management.state, 'managed', 'a completed first collection manages the channel');
  assert.deepEqual((await importLines(t, [second])).items.map(i => i.outcome), ['known']);
});

test('no import is admitted while the Data API quota cannot cover a first collection', async () => {
  const t = await setup({ api_daily_limit: 10 });
  await importLines(t, [channelId()]);
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id), []);
  assert.deepEqual((await t.store.channelImports(t.reader)).counts.queued, 1);
});

async function failImport(t: Awaited<ReturnType<typeof setup>>, plan: Plan, code: 'UNAVAILABLE'|'NOT_FOUND'|'INVALID_REQUEST'|'BUDGET_EXHAUSTED' = 'UNAVAILABLE') {
  const event = {event_id:randomUUID(),execution_epoch:plan.execution_epoch,worker_id:t.worker.subject,phase:'ABOUT',kind:'FAILED' as const,domain:'ABOUT' as const,message:'Integration dependency failure',error_code:code};
  await t.store.event(t.worker,plan.plan_id,event);
  return event;
}
const item = async (t:Awaited<ReturnType<typeof setup>>) => (await t.store.channelImports(t.reader)).items[0]!;
async function dueRetry(t:Awaited<ReturnType<typeof setup>>) {
  await pool.query("UPDATE control.channel_imports SET retry_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND state='failed' AND retry_at IS NOT NULL",[t.op.workspace_id]);
}

test('failed imports back off 5/15/60 minutes, schedule exactly three retries and preserve the original failures',async()=>{
  const t=await setup({},1),id=channelId();await importLines(t,[id]);
  let plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;
  const original=plan.plan_id;
  for(let attempt=0;attempt<=3;attempt++) {
    const started=Date.now(),event=await failImport(t,plan),failed=await item(t);
    assert.equal(failed.retry!.attempts,attempt);
    await t.store.event(t.worker,plan.plan_id,event);assert.deepEqual((await item(t)).retry,failed.retry,'duplicate terminal events do not reschedule');
    assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id),[],'not before the backoff');
    if(attempt===3){assert.equal(failed.retry!.next_at,null);assert.equal(failed.retry!.blocked_reason,'exhausted');break;}
    const delay=Date.parse(failed.retry!.next_at!)-started,expected=[5,15,60][attempt]!*60000;
    assert.ok(delay>=expected && delay<expected+10000);
    await dueRetry(t);
    const admitted=await Promise.all([t.store.scheduleUpdates(t.op.workspace_id),t.store.scheduleUpdates(t.op.workspace_id)]);
    assert.equal(admitted.flat().length,1,'two dispatchers admit only one retry');
    const next=admitted.flat()[0]!;assert.notEqual(next.plan_id,plan.plan_id);assert.equal(next.execution_epoch,1);
    assert.equal((await t.store.getPlan(t.reader,plan.plan_id)).plan.status,'FAILED');plan=next;
  }
  assert.equal((await t.store.getPlan(t.reader,original)).plan.status,'FAILED');
  assert.deepEqual((await importLines(t,[id])).items.map(i=>i.outcome),['queued']);assert.equal((await item(t)).retry!.attempts,0,'an explicit manual import starts a new bounded cycle');
});

test('successful automatic retry completes the import and resolves failures across its retry chain',async()=>{
  const t=await setup(),id=channelId();await importLines(t,[id]);
  let plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;
  for(let n=0;n<2;n++){await failImport(t,plan);await dueRetry(t);plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;}
  await completeFirstCollection(t,plan);
  assert.equal((await item(t)).state,'done');assert.equal((await item(t)).retry!.next_at,null);
  assert.ok((await t.store.failures(t.reader)).items.every(f=>f.state==='RESOLVED'),'all linked failures are resolved only after the replacement completes');
});

test('cancelled and permanent-error imports stay manual; operators can explicitly queue them again',async()=>{
  for(const code of ['cancelled','NOT_FOUND','INVALID_REQUEST'] as const){
    const t=await setup(),id=channelId();await importLines(t,[id]);const plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;
    if(code==='cancelled')await t.store.cancel(t.op,plan.plan_id,{command_id:randomUUID(),expected_version:plan.version});else await failImport(t,plan,code);
    assert.equal((await item(t)).retry!.next_at,null);assert.equal((await item(t)).retry!.blocked_reason,code==='cancelled'?'cancelled':'non_retryable');
    assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id,new Date(Date.now()+86400000)),[]);
    assert.equal((await importLines(t,[id])).queued,1);
  }
});

test('ignored failures stop the scheduled automatic retry',async()=>{
  const t=await setup();await importLines(t,[channelId()]);const plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;await failImport(t,plan);
  const failure=(await t.store.failures(t.reader)).items[0]!;
  await t.store.commandFailure(t.op,failure.failure_id,{command_id:randomUUID(),expected_version:failure.version,action:'ignore',reason:'Operator closed this collection'});
  assert.equal((await item(t)).retry!.blocked_reason,'ignored');assert.equal((await item(t)).retry!.next_at,null);
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id,new Date(Date.now()+86400000)),[]);
});

test('the dispatcher repairs failures settled by an old API during rollout and keeps cancellation manual',async()=>{
  for(const cancelled of [false,true]){
    const t=await setup();await importLines(t,[channelId()]);const plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;
    if(cancelled)await t.store.cancel(t.op,plan.plan_id,{command_id:randomUUID(),expected_version:plan.version});else await failImport(t,plan);
    await pool.query('UPDATE control.channel_imports SET retry_at=NULL,retry_blocked_reason=NULL,last_failure_code=NULL WHERE workspace_id=$1',[t.op.workspace_id]);
    assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id),[]);
    assert.equal((await item(t)).retry!.attempts,0);
    if(cancelled)assert.equal((await item(t)).retry!.blocked_reason,'cancelled');else assert.ok((await item(t)).retry!.next_at);
  }
});

test('due retries wait for API budget, a free Worker slot and the scheduler switch without spending retry attempts',async()=>{
  const t=await setup({},1);await importLines(t,[channelId()]);
  const plan=(await t.store.scheduleUpdates(t.op.workspace_id))[0]!;await failImport(t,plan);await dueRetry(t);
  const config=await t.store.config(t.reader);
  config.settings.discovery.api_reserve=0;
  await pool.query('INSERT INTO control.runtime_settings(workspace_id,version,settings,operator) VALUES($1,1,$2,$3)',[t.op.workspace_id,config.settings,t.op.subject]);
  for(const [field,value] of [['api_daily_limit',1],['enabled',false]] as const){
    await pool.query('UPDATE control.runtime_settings SET settings=jsonb_set(settings,$2,$3::jsonb) WHERE workspace_id=$1',[t.op.workspace_id,['update',field],JSON.stringify(value)]);
    assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id),[]);assert.equal((await item(t)).retry!.attempts,0);
    await pool.query('UPDATE control.runtime_settings SET settings=jsonb_set(settings,$2,$3::jsonb) WHERE workspace_id=$1',[t.op.workspace_id,['update',field],JSON.stringify(field==='enabled'?true:10000)]);
  }
  const other=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:channelId()} as never);
  assert.deepEqual(await t.store.scheduleUpdates(t.op.workspace_id),[],'a manual plan holds the only Worker slot');assert.equal((await item(t)).retry!.attempts,0);
  await t.store.cancel(t.op,other.plan_id,{command_id:randomUUID(),expected_version:other.version});
  assert.equal((await t.store.scheduleUpdates(t.op.workspace_id)).length,1);
});
