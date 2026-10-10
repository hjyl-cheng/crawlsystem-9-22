import test from 'node:test';
import assert from 'node:assert/strict';
import { RawArchive, ArchiveError, captureFetch, type ObjectStore, type RawUnit } from '../src/raw-archive.ts';
import { fixtureContext } from './support.ts';
test('a lost notification is recovered from the durable object, with no raw body in Kafka', async () => {
  const { ref } = fixtureContext(), objects = new Map<string, Uint8Array>();
  const store: ObjectStore = { async get(key) { return objects.get(key) ?? null; }, async put(key, bytes) { objects.set(key, bytes); } };
  const unit: RawUnit = { schema_version: 'crawl.unit.v1', owner: ref, channel_id: 'channel', step: 'VIDEO', unit_id: 'video1', captured_at: new Date().toISOString(),
    responses: [{ endpoint: 'https://www.youtube.com/player', method: 'POST', status: 200, captured_at: new Date().toISOString(), body: 'raw-comment-body' }], result: { title: 'one' } };
  let fail = true; const messages: unknown[] = [];
  const archive = new RawArchive(store, { async send(_topic, _key, message) { assert.ok(objects.size); if (fail) throw new ArchiveError('publish'); messages.push(message); } });
  const signal = new AbortController().signal;
  await assert.rejects(archive.save(unit, signal), ArchiveError); assert.equal(objects.size, 1);
  fail = false;
  const reused = await archive.reuse(ref, 'channel', 'VIDEO', 'video1', signal);
  assert.deepEqual(reused?.result, { title: 'one' }); assert.equal(messages.length, 1);
  assert.ok(!JSON.stringify(messages).includes('raw-comment-body'));
  await archive.finish(ref, 'channel', 'VIDEO', [reused!.reference], signal); assert.equal(objects.size, 2);
  await assert.rejects(archive.reuse({ ...ref, input_hash: 'wrong' }, 'channel', 'VIDEO', 'video1', signal), /integrity/);
  const failing = new RawArchive({ ...store, async put() { throw new ArchiveError('storage'); } }, { async send() { assert.fail('No notification before storage'); } });
  await assert.rejects(failing.save(unit, signal), /storage/);
});
test('response capture retains original text while removing secret URL parameters', async () => {
  const responses: RawUnit['responses'] = [];
  const fetcher = captureFetch(async () => new Response('{ "original": true }'), responses);
  const response = await fetcher('https://www.googleapis.com/youtube/v3/videos?key=secret&id=test');
  assert.equal(await response.text(), '{ "original": true }'); assert.equal(responses[0]!.body, '{ "original": true }');
  assert.ok(!responses[0]!.endpoint.includes('secret'));
});
