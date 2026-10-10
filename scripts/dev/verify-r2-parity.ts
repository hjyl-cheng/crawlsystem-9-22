import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Log } from 'youtubei.js';
const { Innertube: Legacy, Log: LegacyLog } = await import(pathToFileURL(resolve('.runtime/r2/youtube17/dist/src/platform/node.js')).href) as { Innertube: typeof Innertube; Log: typeof Log };
import { Innertube } from 'youtubei.js';
import { MinioStore, type RawUnit, type RawResponse } from '../../apps/execution-worker/src/raw-archive.ts';
import { channelFacts, uploads, videoDetail } from '../../apps/execution-worker/src/youtube/web-scrape.ts';
const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
LegacyLog.setLevel(LegacyLog.Level.NONE);
Log.setLevel(Log.Level.NONE);
const evidence = JSON.parse(readFileSync('.runtime/r2/preview-evidence.json', 'utf8'));
const secret = JSON.parse(kubectl('-n','crawler','get','secret','minio-crawl-worker','-o','json')).data;
const store = new MinioStore(`http://${kubectl('-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}')}:9000`, 'crawl-raw', Buffer.from(secret.access_key,'base64').toString(), Buffer.from(secret.secret_key,'base64').toString());
const archived = new Map<string, { sha256: string; bytes: number; responses: number }>();
async function unit(step: string, id: string): Promise<RawUnit> {
  const raw = await store.get(`v1/m1-main/${evidence.plan_id}/1/${step}/${id}.json.gz`, new AbortController().signal);
  assert.ok(raw);
  const parsed: RawUnit = JSON.parse(gunzipSync(raw).toString());
  assert.equal(parsed.schema_version, 'crawl.unit.v1'); assert.equal(parsed.owner.plan_id, evidence.plan_id);
  assert.equal(parsed.step, step); assert.equal(parsed.unit_id, id); assert.ok(parsed.responses.length > 0);
  archived.set(`${step}/${id}`, { sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length, responses: parsed.responses.length });
  return parsed;
}
function replay(responses: RawResponse[]) {
  const remaining = [...responses], played: RawResponse[] = []; let misses = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    let client: string | undefined;
    try { client = JSON.parse(await request.clone().text()).context?.client?.clientName; } catch {}
    const index = remaining.findIndex(r => r.endpoint === url.origin + url.pathname && (!r.client || !client || r.client === client));
    if (index < 0) { misses++; throw new Error('Replay has no response for the requested endpoint'); }
    const response = remaining.splice(index, 1)[0]!;
    played.push(response);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, played, misses: () => misses };
}
async function client(version: typeof Innertube, fetcher: typeof fetch) {
  return version.create({ fetch: fetcher, lang: 'pt-BR', location: 'BR', timezone: 'America/Sao_Paulo', retrieve_player: false, generate_session_locally: true, retrieve_innertube_config: false, enable_session_cache: false });
}
const old = Legacy as unknown as typeof Innertube, channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw', checks: unknown[] = [];
const about = await unit('ABOUT','channel');
const channels = await Promise.all([old, Innertube].map(async version => channelFacts(await client(version, replay(about.responses).fetcher), channel)));
for (const field of ['title','handle','subscriber_count','total_view_count','total_video_count','country','joined_at'] as const) {
  const normalize = (v: any) => typeof v === 'object' && v ? v.value : v;
  assert.deepEqual(normalize(channels[0]![field]), normalize(channels[1]![field]));
}
checks.push({ unit: 'ABOUT', result: 'same title, handle, counts, country and join date' });
const listed = await unit('TARGETS','uploads');
const lists = await Promise.all([old, Innertube].map(async version => uploads(await client(version, replay(listed.responses).fetcher), channel, 2)));
assert.deepEqual(lists[0]!.ids, lists[1]!.ids); checks.push({ unit: 'TARGETS', result: 'same frozen video IDs' });
for (const id of evidence.targets) {
  const detail = await unit('VIDEO-0', id);
  const results = await Promise.all([old, Innertube].map(async version => {
    const transport = replay(detail.responses);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const v = await videoDetail(await client(version, transport.fetcher), channel, id, 5, false, transport.played);
        assert.equal(transport.misses(), 0, 'Replay requested a response that was not archived');
        return 'unavailable' in v ? { access: v.access_status } : { title: v.title, published_at: v.published_at, precision: v.published_at_precision, views: v.view_count.value, type: v.content_type, comments: v.comments_first_page?.returned_count ?? null };
      } catch (error) {
        assert.equal(transport.misses(), 0, 'Replay requested a response that was not archived');
        if (attempt === 3) {
          assert.ok(detail.responses.some(r => r.endpoint === 'https://www.googleapis.com/youtube/v3/videos'), 'Exhaustion is only expected for an archived API fallback');
          return { web: 'exhausted', fallback: 'Data API', error: error instanceof Error ? error.name : 'unknown' };
        }
      }
    }
    throw new Error('Unreachable replay state');
  }));
  const facts = results;
  assert.deepEqual(facts[0],facts[1]); checks.push({ unit: id, result: facts[0] });
}
for (const step of ['ABOUT', 'TARGETS', 'VIDEO-0']) {
  const bytes = await store.get(`v1/m1-main/${evidence.plan_id}/1/${step}/_manifest.json.gz`, new AbortController().signal);
  assert.ok(bytes, `${step} manifest must be stored`);
  const manifest = JSON.parse(gunzipSync(bytes).toString());
  assert.equal(manifest.schema_version, 'crawl.step.v1'); assert.equal(manifest.owner.plan_id, evidence.plan_id);
  assert.equal(manifest.units.length, step === 'VIDEO-0' ? evidence.targets.length : 1);
  for (const ref of manifest.units) {
    const saved = archived.get(`${step}/${ref.unit_id}`); assert.ok(saved);
    assert.equal(ref.sha256, saved.sha256); assert.equal(ref.bytes, saved.bytes);
  }
}
const result = { result: 'PASSED', method: 'Replay the same stored raw collection units through both versions, without another YouTube request', versions: ['17.2.0','18.1.0'], plan_id: evidence.plan_id, checks,
  archive: { units: archived.size, manifests: 3, hashes_verified: true, response_counts: Object.fromEntries([...archived].map(([key, value]) => [key, value.responses])) } };
writeFileSync('.runtime/r2/parity-evidence.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
