import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCollector, webOperations, type CollectionContext } from '../src/youtube/web-collector.ts';
import { RawArchive } from '../src/raw-archive.ts';
import { DataApi } from '../src/youtube/data-api.ts';
import { ScrapeError } from '../src/youtube/scrape.ts';
import { fixtureContext } from './support.ts';
import { mergeRecoveryVideoTargets } from '@crawlsystem/contracts';
import { gunzipSync } from 'node:zlib';
test('successful units are saved immediately; fallback occurs after three attempts and retries reuse durable results', async () => {
  const { ref, value } = fixtureContext(), objects = new Map<string, Uint8Array>(), events: string[] = [];
  const archive = new RawArchive({ async get(key) { return objects.get(key) ?? null; }, async put(key, data) { objects.set(key, data); } }, { async send(topic) { events.push(topic); } });
  let attempts = 0, apiCalls = 0;
  const api = new DataApi('k'.repeat(30), async () => { apiCalls++; assert.equal(attempts, 3); assert.ok(objects.size, 'the first completed video was already stored'); return Response.json({ items: [] }); });
  const gateway = { async withProfile(_lease: unknown, _signal: AbortSignal, work: (t: unknown) => unknown) { return work({ fetch, identity: { profile_id: 'p' } }); } };
  const releases: string[] = [];
  const proxies = { async acquire() { return { proxy_id: 'proxy', lease_id: 'lease', proxy_url: 'http://localhost:1', expires_at: Date.now() + 60_000 }; }, async release(_l: unknown, outcome: string) { releases.push(outcome); } };
  const first = value.input.source_mode === 'fixture' ? value.input.sample.videos[0]! : null;
  const ops = { ...webOperations, async browserSession() { return {} as never; }, async videoDetail(_yt: unknown, _channel: string, id: string) { if (id === 'ok') return first!; attempts++; throw new ScrapeError('parse', 'failure'); } };
  const collector = new WebCollector(gateway as never, proxies as never, archive, api, false, ops);
  const ctx: CollectionContext = { owner: ref, channelId: value.input.channel_id, deadline: Date.now() + 60_000, signal: new AbortController().signal, note: async () => {}, guard: { async permit() { return 'permit'; } } };
  const results = await collector.videos(ctx, ['ok', 'bad'], 0, 'VIDEO');
  assert.equal(results.length, 2); assert.equal(apiCalls, 1); assert.ok(releases.every(outcome => outcome === 'success'), 'parse failures never penalize proxies');
  await collector.videos(ctx, ['ok', 'bad'], 0, 'VIDEO');
  assert.equal(attempts, 3); assert.equal(apiCalls, 1); assert.equal(events.filter(e => e === 'crawl.step').length, 2);
});

test('recovery survives a matched anchor, stays in the archived targets and is reused without another scan', async () => {
  const { ref, value } = fixtureContext(), objects = new Map<string, Uint8Array>(); let scans = 0;
  const archive = new RawArchive({ async get(key) { return objects.get(key) ?? null; }, async put(key, data) { objects.set(key, data); } }, { async send() {} });
  const gateway = { async withProfile(_lease: unknown, _signal: AbortSignal, work: (t: unknown) => unknown) { return work({ fetch, identity: { profile_id: 'p' } }); } };
  const proxies = { async acquire() { return {}; }, async release() {} };
  const ops = { ...webOperations, async browserSession() { return {} as never; }, async uploads(_yt: unknown, _channel: string, _limit: number, anchors?: string[]) {
    scans++; assert.deepEqual(anchors, ['anchor00001']); return { ids: ['newvideo001', 'partial0001'], scanned: 3, pages: 1,
      matched_anchor_id: 'anchor00001', stop_reason: 'anchor_matched' as const, exhausted: false };
  } };
  const collector = new WebCollector(gateway as never, proxies as never, archive, new DataApi('k'.repeat(30)), false, ops);
  const ctx: CollectionContext = { owner: ref, channelId: value.input.channel_id, deadline: Date.now() + 60_000,
    signal: new AbortController().signal, note: async () => {}, guard: { async permit() { return 'permit'; } } };
  const recovery = ['partial0001', 'missing0001'];
  const result = await collector.targets(ctx, 100, ['anchor00001'], recovery);
  assert.deepEqual(result.ids, ['partial0001', 'missing0001', 'newvideo001']);
  assert.equal(result.scanned, 3); assert.equal(result.matched_anchor_id, 'anchor00001');
  assert.deepEqual((await collector.targets(ctx, 100, ['anchor00001'], recovery)).ids, result.ids); assert.equal(scans, 1);
});

test('recovery takes priority within the 100-target limit including discovery gap fallback', () => {
  const recovery = Array.from({ length: 90 }, (_, i) => String(i).padStart(11, '0'));
  const discovered = Array.from({ length: 30 }, (_, i) => String(i + 85).padStart(11, '0'));
  const targets = mergeRecoveryVideoTargets(discovered, recovery);
  assert.equal(targets.length, 100); assert.deepEqual(targets.slice(0, 90), recovery); assert.equal(new Set(targets).size, 100);
  assert.deepEqual(mergeRecoveryVideoTargets(discovered), discovered);
});

test('a listed upload owned by another channel is kept with the collected channel and its owner recorded', async () => {
  const { ref, value } = fixtureContext(), objects = new Map<string, Uint8Array>(), events: string[] = [];
  const archive = new RawArchive({ async get(key) { return objects.get(key) ?? null; }, async put(key, data) { objects.set(key, data); } },
    { async send(topic) { events.push(topic); } });
  const videoId = 'foreign0001', owner = 'UC' + 'b'.repeat(22), at = new Date().toISOString();
  const apiBody = { items: [{ id: videoId, snippet: { channelId: owner, title: 'gio., Dell Mac - ABBA HOLD', publishedAt: at }, statistics: { viewCount: '10' }, status: { privacyStatus: 'public' } }] };
  let permits = 0, attempts = 0;
  const api = new DataApi('k'.repeat(30), async () => Response.json(apiBody));
  const gateway = { async withProfile(_lease: unknown, _signal: AbortSignal, work: (t: unknown) => unknown) { return work({ fetch, identity: { profile_id: 'p' } }); } };
  const proxies = { async acquire() { return {}; }, async release() {} };
  const ops = { ...webOperations, async browserSession() { return {} as never; }, async videoDetail() { attempts++; throw new ScrapeError('parse', 'WEB and IOS video details exhausted'); } };
  const collector = new WebCollector(gateway as never, proxies as never, archive, api, false, ops);
  const ctx: CollectionContext = { owner: ref, channelId: value.input.channel_id, deadline: Date.now() + 60_000,
    signal: new AbortController().signal, note: async () => {}, guard: { async permit() { permits++; return 'permit'; } } };
  const [item] = await collector.videos(ctx, [videoId], 0, 'VIDEO-0');
  assert.ok(item && !('unavailable' in item)); assert.equal(item.channel_id, value.input.channel_id); assert.equal(item.owner_channel_id, owner);
  assert.equal(attempts, 3); assert.equal(permits, 1);
  const saved = [...objects.values()].map(bytes => JSON.parse(gunzipSync(bytes).toString())).find(u => u.unit_id === videoId);
  assert.ok(saved, 'the collaboration is archived as a collected unit'); assert.deepEqual(JSON.parse(saved.responses.at(-1).body), apiBody);
  assert.equal(events.filter(e => e === 'crawl.step').length, 1);
});
