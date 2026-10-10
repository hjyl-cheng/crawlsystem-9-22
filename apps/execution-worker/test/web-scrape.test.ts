import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteDate, mapWebVideo, uploads, videoDetail } from '../src/youtube/web-scrape.ts';
import { topComments, ScrapeError } from '../src/youtube/scrape.ts';
import { parseCount } from '../src/youtube/map.ts';
const channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw', id = 'abcdefghijk';
const info = () => ({ basic_info: { title: 'test', channel_id: channel, duration: 120, view_count: 432 }, playability_status: { status: 'OK' }, page: [{ microformat: { publish_date: '2026-10-01' } }] });
test('Portuguese counts and dates retain estimates, day precision and missing counts', () => {
  assert.deepEqual(parseCount('1,23 mi de inscritos', 'pt-BR'), { value: 1_230_000, exact: false });
  assert.deepEqual(parseCount('1.234.567 visualizações', 'pt-BR'), { value: 1_234_567, exact: true });
  assert.equal(parseCount('inscritos indisponíveis', 'pt-BR'), null);
  assert.equal(absoluteDate('Estreou em 3 de out. de 2026').value, '2026-10-03T00:00:00.000Z');
  const mapped = mapWebVideo(info(), channel, id, { kind: 'unavailable', collected_at: new Date().toISOString() }, 20);
  assert.equal(mapped.published_at_precision, 'date_only'); assert.equal(mapped.view_count.value, 432);
  assert.equal(mapped.comment_count.value, null); assert.equal(mapped.comments_disabled, null);
});
test('WEB is tried before IOS; two plain sign-ins settle without penalizing a proxy', async () => {
  const clients: string[] = [];
  const yt = { async getInfo(_id: string, opts: { client: string }) { clients.push(opts.client); return opts.client === 'WEB' ? { playability_status: { status: 'UNPLAYABLE', reason: 'Video unavailable' } } : info(); } };
  const result = await videoDetail(yt as never, channel, id, 0);
  assert.ok(!('unavailable' in result)); assert.deepEqual(clients, ['WEB', 'IOS']);
  const login = await videoDetail({ async getInfo() { return { playability_status: { status: 'LOGIN_REQUIRED', reason: 'Please sign in' } }; } } as never, channel, id, 0);
  assert.ok('unavailable' in login); assert.equal(login.access_status, 'login_required');
  await assert.rejects(videoDetail({ async getInfo() { return { playability_status: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } }; } } as never, channel, id, 0), (error: unknown) => error instanceof ScrapeError && error.kind === 'blocked');
});
test('empty TOP with a positive count retries NEWEST once; absent comments never imply zero', async () => {
  const calls: string[] = [];
  const result = await topComments({ async getComments(_id: string, sort: string) { calls.push(sort); return { header: { comments_count: '12' }, contents: sort === 'TOP_COMMENTS' ? [] : [{ comment: { comment_id: 'comment', content: 'hello' } }] }; } } as never, id, undefined);
  assert.deepEqual(calls, ['TOP_COMMENTS', 'NEWEST_FIRST']); assert.equal(result.kind, 'page');
  if (result.kind === 'page') { assert.equal(result.sort, 'NEWEST_FIRST'); assert.equal(result.comments.length, 1); }
  const absent = await topComments({ async getComments() { throw new Error('Comments page did not have any content'); } } as never, id, undefined);
  assert.equal(absent.kind, 'unavailable');
});
test('uploads freeze latest IDs and incremental discovery stops at any frozen anchor', async () => {
  const videos = Array.from({ length: 50 }, (_, i) => ({ id: String(i).padStart(11, '0') }));
  const yt = { async getPlaylist() { return { videos, has_continuation: true, async getContinuation() { assert.fail('The frozen bound was reached'); } }; } };
  assert.equal((await uploads(yt as never, channel, 30)).ids.length, 30);
  const found = await uploads(yt as never, channel, 100, [videos[4]!.id]);
  assert.equal(found.ids.length, 4); assert.equal(found.matched_anchor_id, videos[4]!.id);
});
