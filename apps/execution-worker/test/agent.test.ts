import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockActivityEnvironment } from '@temporalio/testing';
import { AgentInputSchema, AgentProfileSchema, AgentResultSchema, type AgentInput } from '@crawlsystem/contracts';
import { agentInputHash } from '@crawlsystem/contracts/hash';
import { ExecutionApi, ExecutionApiError } from '@crawlsystem/execution-client/http';
import { createActivities } from '../src/activities.ts';
import { ProfileClient } from '../src/profile-client.ts';
import { fixtureApi, fixtureContext } from './support.ts';

// The Profile Agent's own tests (Python) produce this golden output from the same input.
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../profile-agent/tests/${name}`, import.meta.url), 'utf8'));
const sampleInput = read('agent-input.json') as AgentInput, golden = read('expected-profile.json');
const run = <T>(env: MockActivityEnvironment, fn: () => Promise<T>) => env.run<[], T, typeof fn>(fn);

test('Profile Agent fixture and golden output satisfy the shared contracts', () => {
  const input = AgentInputSchema.parse(sampleInput);
  const { input_hash, ...body } = input;
  assert.equal(agentInputHash(body), input_hash);
  const profile = AgentProfileSchema.parse(golden);
  AgentResultSchema.parse({ channel_id: input.channel_id, input_hash, model_version: profile.model_version, taxonomy_version: profile.taxonomy_version, observed_at: profile.observed_at, facts: profile.facts });
  assert.equal(profile.facts.channel_tags.value.tags.length, 10);
});

test('ProfileClient classifies Profile Agent responses', async () => {
  const reply = (status: number, body: unknown) => new ProfileClient('http://profile.test', async () => Response.json(body, { status }));
  assert.deepEqual(await reply(200, golden).profile(sampleInput), golden);
  const rejects = (client: ProfileClient, code: string, retryable: boolean) => assert.rejects(client.profile(sampleInput), (e: unknown) => e instanceof ExecutionApiError && e.code === code && e.retryable === retryable);
  await rejects(reply(422, { error: 'invalid_input' }), 'INVALID_REQUEST', false);
  await rejects(reply(500, { error: 'profile_failed' }), 'UNAVAILABLE', true);
  await rejects(reply(200, { ...golden, facts: {} }), 'INTERNAL_ERROR', false);
  await rejects(new ProfileClient('http://profile.test', async () => { throw new TypeError('connect refused'); }), 'UNAVAILABLE', true);
});

function setup() {
  const { value, ref } = fixtureContext(['ABOUT', 'VIDEO', 'AGENT']);
  value.domains.find(d => d.domain === 'ABOUT')!.state = 'APPLIED'; value.domains.find(d => d.domain === 'VIDEO')!.state = 'APPLIED'; value.plan.status = 'RUNNING';
  const backend = fixtureApi(value), faults = { staleInputOnce: false, agentInputReads: 0 };
  let input = { ...sampleInput, plan_id: ref.plan_id };
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/agent-input')) { faults.agentInputReads++; return Response.json(input); }
    if (path.endsWith('/submissions') && faults.staleInputOnce) {
      // Another plan rewrote the channel's facts after this Worker read them.
      faults.staleInputOnce = false; input = { ...input, input_hash: `sha256:${'1'.repeat(64)}` };
      return Response.json({ error: { code: 'INPUT_MISMATCH', retryable: false, message: 'test', correlation_id: 'c' } }, { status: 409 });
    }
    return backend.fetcher(url, options);
  };
  const profiles: AgentInput[] = [];
  const profiler = new ProfileClient('http://profile.test', async (_url, init) => { profiles.push(JSON.parse(String(init?.body))); return Response.json(golden); });
  const api = new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'test', fetch: fetcher });
  const activities = createActivities({ api, workerId: 'worker-test', workspaceId: ref.workspace_id, enter: () => () => {}, log: () => {}, profiler });
  const descriptor = { deadlineAt: Date.now() + 60_000, maxAttempts: 3, status: 'RUNNING' as const, sourceMode: 'youtube' as const, requiresAgent: true };
  return { value, ref, backend, faults, profiles, activities, descriptor, env: new MockActivityEnvironment() };
}

test('collectAgent submits the profile bound to the input hash and seals AGENT once', async () => {
  const f = setup();
  assert.equal((await run(f.env, () => f.activities.collectAgent(f.ref, f.descriptor))).status, 'COMPLETED');
  const submission = f.backend.submissions.at(-1)!;
  assert.equal(submission.domain, 'AGENT'); assert.equal(submission.domain_complete, true);
  const payload = AgentResultSchema.parse(submission.payload);
  assert.equal(payload.input_hash, sampleInput.input_hash); assert.equal(payload.model_version, golden.model_version);
  assert.equal(f.profiles[0]!.plan_id, f.ref.plan_id);
  assert.ok(f.backend.events.some(e => e.phase === 'AGENT' && e.kind === 'PROGRESS'));
  // A retried attempt after the seal does no work.
  assert.equal((await run(new MockActivityEnvironment({ attempt: 2 }), () => f.activities.collectAgent(f.ref, f.descriptor))).status, 'COMPLETED');
  assert.equal(f.backend.submissions.length, 1); assert.equal(f.profiles.length, 1);
});

test('collectAgent re-reads and re-profiles when the Store rejects a stale input hash', async () => {
  const f = setup(); f.faults.staleInputOnce = true;
  assert.equal((await run(f.env, () => f.activities.collectAgent(f.ref, f.descriptor))).status, 'COMPLETED');
  assert.equal(f.faults.agentInputReads, 2); assert.equal(f.profiles.length, 2);
  assert.equal(AgentResultSchema.parse(f.backend.submissions.at(-1)!.payload).input_hash, `sha256:${'1'.repeat(64)}`);
});

test('collectAgent without a Profile Agent fails as not implemented, not retryable', async () => {
  const f = setup();
  const activities = createActivities({ api: new ExecutionApi({ controlUrl: 'http://localhost:1', ingestUrl: 'http://localhost:2', token: async () => 'test', fetch: f.backend.fetcher }),
    workerId: 'worker-test', workspaceId: f.ref.workspace_id, enter: () => () => {}, log: () => {} });
  await assert.rejects(run(f.env, () => activities.collectAgent(f.ref, f.descriptor)), (e: unknown) => e instanceof Error && 'nonRetryable' in e && e.nonRetryable === true && e.message.includes('DEPENDENCY_NOT_IMPLEMENTED'));
});
