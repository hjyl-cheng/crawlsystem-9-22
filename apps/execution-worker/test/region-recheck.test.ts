import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import type { ChannelFacts, VideoItem } from '@crawlsystem/contracts';
import { WebCollector, webOperations, type CollectionContext } from '../src/youtube/web-collector.ts';
import { RawArchive, type RawResponse, type RawUnit } from '../src/raw-archive.ts';
import { DataApi } from '../src/youtube/data-api.ts';
import { ScrapeError } from '../src/youtube/scrape.ts';
import { ProxyUnavailable } from '../src/youtube/transport.ts';
import { fixtureContext } from './support.ts';

// A fake YouTube session that remembers its location and records one browse request through the captured fetch.
type Session = { region: string; fetcher: typeof fetch };
const unavailable = JSON.stringify({ alerts: [{ alertRenderer: { text: { simpleText: 'Este canal não está disponível.' } } }] });
function harness(apiCountry: string, { reserve = true, exit }: { reserve?: boolean; exit?: string } = {}) {
  const { ref, value } = fixtureContext(), objects = new Map<string, Uint8Array>(), notes: string[] = [], acquired: (string | undefined)[] = [];
  const channel = value.input.channel_id, sample = value.input.source_mode === 'fixture' ? value.input.sample : null;
  const archive = new RawArchive({ async get(key) { return objects.get(key) ?? null; }, async put(key, data) { objects.set(key, data); } }, { async send() {} });
  let apiCalls = 0;
  const api = new DataApi('k'.repeat(30), async () => { apiCalls++; return Response.json({ items: [{ id: channel, snippet: { title: 'Pfizer', country: apiCountry, publishedAt: '2009-07-15T18:41:35Z' },
    statistics: { subscriberCount: '89500', viewCount: '48863112', videoCount: '1150' } }] }); });
  // YouTube's exit check answers with the lease's country unless the test pins another exit.
  const swJsData = (country: string) => `)]}'\n${JSON.stringify([[null, null, [[[null, country, null, '192.0.2.1']]]]])}`;
  const gateway = { async withProfile(lease: { egress_country: string }, _signal: AbortSignal, work: (t: unknown) => unknown) {
    return work({ identity: { profile_id: 'p' }, fetch: async (url: string) => new Response(String(url).endsWith('/sw.js_data') ? swJsData(exit ?? lease.egress_country) : unavailable, { status: 200 }) }); } };
  const proxies = { async acquire(_ttl: number, country?: string) {
    acquired.push(country);
    if (country && !reserve) throw new ProxyUnavailable('no_country_proxies', 60_000);
    return { proxy_id: 'proxy', lease_id: 'lease', proxy_url: 'http://localhost:1', expires_at: Date.now() + 60_000, egress_country: country ?? 'RO' };
  }, async release() {} };
  const browse = (yt: Session) => yt.fetcher('https://www.youtube.com/youtubei/v1/browse', { method: 'POST', body: JSON.stringify({ context: { client: { clientName: 'WEB' } } }) });
  const ops = { ...webOperations,
    async browserSession(fetcher: typeof fetch, _identity: unknown, region = 'BR') { return { region, fetcher } as never; },
    async channelFacts(yt: Session) { await browse(yt); if (yt.region !== 'US') throw new ScrapeError('not_found', 'Channel or video not found'); return { ...sample!.about, channel_id: channel } as ChannelFacts; },
    async videoDetail(yt: Session, _channel: string, id: string): Promise<VideoItem> {
      await browse(yt);
      return yt.region === 'US' ? { ...sample!.videos[0]!, source_content_id: id } : { channel_id: channel, source_content_id: id, unavailable: true, access_status: 'region_blocked',
        reason: 'YouTube player reports region_blocked', source: 'youtubei:player', observed_at: new Date().toISOString() };
    } };
  const collector = new WebCollector(gateway as never, proxies as never, archive, api, false, ops as never);
  const ctx: CollectionContext = { owner: ref, channelId: channel, deadline: Date.now() + 60_000, signal: new AbortController().signal,
    note: async message => { notes.push(message); }, guard: { async permit() { return 'permit'; } } };
  const units = () => [...objects.values()].map(bytes => JSON.parse(gunzipSync(bytes).toString()) as RawUnit).filter(u => u.schema_version === 'crawl.unit.v1');
  return { collector, ctx, notes, acquired, units, apiCalls: () => apiCalls };
}

test('an About page unavailable to the default identity is collected again in the channel country', async () => {
  const t = harness('US'), facts = await t.collector.about(t.ctx);
  assert.ok('title' in facts); assert.equal(facts.country_code, 'US');
  assert.deepEqual(t.acquired, [undefined, 'US'], 'the recheck leases a proxy of the channel country');
  const responses: RawResponse[] = t.units().find(u => u.step === 'ABOUT')!.responses;
  assert.deepEqual(responses.map(r => r.region ?? null), [null, null, 'US'], 'default page, Data API record, then the regional page');
  assert.ok(t.notes.includes('About: rechecked in US'));
});

test('without a proxy of that country the About falls back to the Data API record at once', async () => {
  const t = harness('US', { reserve: false }), facts = await t.collector.about(t.ctx);
  assert.ok('title' in facts); assert.equal(facts.title, 'Pfizer'); assert.equal(facts.source, 'data_api:channels_fallback');
  assert.ok(t.notes.some(n => n.includes('no US proxy reserve')));
  assert.deepEqual(t.units().find(u => u.step === 'ABOUT')!.responses.map(r => r.region ?? null), [null, null]);
});

test('a channel of the default country is not rechecked; its About comes from the Data API record', async () => {
  const t = harness('BR'), facts = await t.collector.about(t.ctx);
  assert.ok('title' in facts); assert.equal(facts.source, 'data_api:channels_fallback'); assert.equal(facts.country_code, 'BR');
  assert.deepEqual(t.acquired, [undefined]);
});

test('a video blocked for the default identity is read again in the channel country found once per batch', async () => {
  const t = harness('US'), items = await t.collector.videos(t.ctx, ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 0, 'VIDEO-0');
  assert.ok(items.every(i => !('unavailable' in i)), 'both videos are collected in US');
  assert.equal(t.apiCalls(), 1, 'one Data API lookup gives the channel country for the batch');
  assert.deepEqual(t.acquired, [undefined, 'US', undefined, 'US']);
  const first = t.units().find(u => u.unit_id === 'aaaaaaaaaaa')!;
  assert.deepEqual(first.responses.map(r => r.region ?? null), [null, null, 'US']);
});

test('without a proxy of that country a region-blocked video keeps its default result', async () => {
  const t = harness('US', { reserve: false }), [item] = await t.collector.videos(t.ctx, ['aaaaaaaaaaa'], 0, 'VIDEO-0');
  assert.ok(item && 'unavailable' in item); assert.equal(item.access_status, 'region_blocked');
  assert.ok(t.notes.some(n => n.includes('no US proxy reserve')));
});

test('a proxy whose YouTube exit is not the channel country is skipped, and the About falls back after three', async () => {
  const t = harness('US', { exit: 'RO' }), facts = await t.collector.about(t.ctx);
  assert.ok('title' in facts); assert.equal(facts.source, 'data_api:channels_fallback');
  assert.deepEqual(t.acquired, [undefined, 'US', 'US', 'US']);
  assert.equal(t.notes.filter(n => n.includes('YouTube sees exit RO, not US')).length, 3);
  assert.ok(t.notes.some(n => n.includes('no US proxy reserve')));
  assert.deepEqual(t.units().find(u => u.step === 'ABOUT')!.responses.map(r => r.region ?? null), [null, null], 'the exit check is not a captured response');
});
