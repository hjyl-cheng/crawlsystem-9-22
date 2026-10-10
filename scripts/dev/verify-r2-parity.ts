import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const evidence = JSON.parse(readFileSync('.runtime/r2/preview-evidence.json', 'utf8'));
const secret = JSON.parse(kubectl('-n','crawler','get','secret','minio-crawl-worker','-o','json')).data;
const store = new MinioStore(`http://${kubectl('-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}')}:9000`, 'crawl-raw', Buffer.from(secret.access_key,'base64').toString(), Buffer.from(secret.secret_key,'base64').toString());
async function unit(step: string, id: string): Promise<RawUnit> {
  const raw = await store.get(`v1/m1-main/${evidence.plan_id}/1/${step}/${id}.json.gz`, new AbortController().signal);
  assert.ok(raw); return JSON.parse(gunzipSync(raw).toString());
}
function replay(responses: RawResponse[]): typeof fetch {
  const remaining = [...responses];
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    let client: string | undefined;
    try { client = JSON.parse(await request.clone().text()).context?.client?.clientName; } catch {}
    const index = remaining.findIndex(r => r.endpoint === url.origin + url.pathname && (!r.client || !client || r.client === client));
    if (index < 0) throw new Error('Replay has no response for the requested endpoint');
    const response = remaining.splice(index, 1)[0]!;
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
}
async function client(version: typeof Innertube, responses: RawResponse[]) {
  return version.create({ fetch: replay(responses), lang: 'pt-BR', location: 'BR', timezone: 'America/Sao_Paulo', retrieve_player: false, generate_session_locally: true, retrieve_innertube_config: false, enable_session_cache: false });
}
const old = Legacy as unknown as typeof Innertube, channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw', checks: unknown[] = [];
const about = await unit('ABOUT','channel');
const channels = await Promise.all([old, Innertube].map(async version => channelFacts(await client(version, about.responses), channel)));
for (const field of ['title','handle','subscriber_count','total_view_count','total_video_count','country','joined_at'] as const) {
  const normalize = (v: any) => typeof v === 'object' && v ? v.value : v;
  assert.deepEqual(normalize(channels[0]![field]), normalize(channels[1]![field]));
}
checks.push({ unit: 'ABOUT', result: 'same title, handle, counts, country and join date' });
const listed = await unit('TARGETS','uploads');
const lists = await Promise.all([old, Innertube].map(async version => uploads(await client(version, listed.responses), channel, 2)));
assert.deepEqual(lists[0]!.ids, lists[1]!.ids); checks.push({ unit: 'TARGETS', result: 'same frozen video IDs' });
for (const id of evidence.targets) {
  const detail = await unit('VIDEO-0', id);
  const results = await Promise.all([old, Innertube].map(async version => videoDetail(await client(version, detail.responses), channel, id, 5, false, detail.responses)));
  const facts = results.map(v => 'unavailable' in v ? { access: v.access_status } : { title: v.title, published_at: v.published_at, precision: v.published_at_precision, views: v.view_count.value, type: v.content_type, comments: v.comments_first_page?.returned_count ?? null });
  assert.deepEqual(facts[0],facts[1]); checks.push({ unit: id, result: facts[0] });
}
const result = { result: 'PASSED', method: 'Replay the same stored raw collection units through both versions, without another YouTube request', versions: ['17.2.0','18.1.0'], plan_id: evidence.plan_id, checks };
writeFileSync('.runtime/r2/parity-evidence.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
