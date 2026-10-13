import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteDate, channelFacts, mapWebVideo, playability, uploads, videoDetail } from '../src/youtube/web-scrape.ts';
import { topComments, ScrapeError } from '../src/youtube/scrape.ts';
import { parseCount } from '../src/youtube/map.ts';
const channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw', id = 'abcdefghijk';
const info = () => ({ basic_info: { title: 'test', channel_id: channel, duration: 120, view_count: 432 }, playability_status: { status: 'OK' }, page: [{ microformat: { publish_date: '2026-10-01' } }] });
test('channel metadata accepts the real quoted keyword string despite YouTube.js declaring an array', async () => {
  const yt = { async getChannel() { return { metadata: { title: 'channel', keywords: '"google developers" android', avatar: [] }, tabs: ['Home'],
    async getAbout() { return { metadata: { subscriber_count: '1,2 mi de inscritos', links: [] } }; } }; } };
  const facts = await channelFacts(yt as never, channel);
  assert.deepEqual(facts.keywords, ['google developers', 'android']); assert.equal(facts.subscriber_count.value, 1_200_000);
});
test('Portuguese counts and dates retain estimates, day precision and missing counts', () => {
  assert.deepEqual(parseCount('1,23 mi de inscritos', 'pt-BR'), { value: 1_230_000, exact: false });
  assert.deepEqual(parseCount('1.234.567 visualizações', 'pt-BR'), { value: 1_234_567, exact: true });
  assert.equal(parseCount('inscritos indisponíveis', 'pt-BR'), null);
  assert.equal(absoluteDate('Estreou em 3 de out. de 2026', 'pt-BR').value, '2026-10-03T00:00:00.000Z');
  // English sessions (legacy control language) read the English display date; text in another language is not guessed.
  assert.equal(absoluteDate('Premiered Oct 3, 2026', 'en').value, '2026-10-03T00:00:00.000Z');
  assert.equal(absoluteDate('Estreou em 3 de out. de 2026', 'en').value, null);
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
test('real LockupView and ShortsLockupView uploads freeze valid IDs and match anchors', async () => {
  const videos = [{ type: 'LockupView', content_id: 'abcdefghijk' },
    { type: 'ShortsLockupView', entity_id: 'shorts-shelf-item-12345678901', on_tap_endpoint: { payload: { videoId: '12345678901' } } }];
  const yt = { async getPlaylist() { return { videos, has_continuation: false }; } };
  assert.deepEqual((await uploads(yt as never, channel, 2)).ids, ['abcdefghijk', '12345678901']);
  const incremental = await uploads(yt as never, channel, 100, ['12345678901']);
  assert.deepEqual(incremental.ids, ['abcdefghijk']); assert.equal(incremental.matched_anchor_id, '12345678901');
});

test('a listed upload owned by another channel stays with this channel and records the player owner', () => {
  const owner = 'UC' + 'b'.repeat(22), foreign = info(); foreign.basic_info.channel_id = owner;
  const facts = mapWebVideo(foreign, channel, id, { kind: 'skipped' }, 0);
  assert.equal(facts.channel_id, channel); assert.equal(facts.owner_channel_id, owner);
  assert.equal(mapWebVideo(info(), channel, id, { kind: 'skipped' }, 0).owner_channel_id, undefined, 'own uploads carry no owner field');
});

test('region blocks are recognised in the legacy English wording and the pt-BR player text', () => {
  for (const reason of ['The uploader has not made this video available in your country', 'O usuário que enviou o vídeo não o disponibilizou no seu país.', 'Este vídeo não está disponível em seu país'])
    assert.deepEqual(playability({ status: 'UNPLAYABLE', reason }), { kind: 'content', access: 'public', availability: 'region_restricted', reason_code: 'region_restricted', alternate_region: true }, reason);
});

// Ported from oldsystem qybullmq/test/youtubeJs.test.js (playability and access rules, batch 2a).
const withPlayability = (playability_status: Record<string, string>) => ({ ...info(), playability_status });
const client = (answers: Record<string, unknown>, calls: string[] = []) => ({ async getInfo(_id: string, opts: { client: string }) {
  calls.push(opts.client); const answer = answers[opts.client]; if (answer instanceof Error) throw answer; return answer; } });
test('generic WEB playability errors do not override a complete public metadata surface', async () => {
  const calls: string[] = [];
  const video = await videoDetail(client({ WEB: withPlayability({ status: 'UNPLAYABLE', reason: 'Video unavailable' }) }, calls) as never, channel, id, 0);
  assert.ok(!('unavailable' in video)); assert.equal(video.access_status, 'public'); assert.equal(video.availability, 'public');
  assert.equal(video.access_status_source, 'youtubei:public_metadata'); assert.deepEqual(calls, ['WEB'], 'a complete surface is accepted without IOS');
});
test('an unknown LOGIN_REQUIRED reason cannot override a complete public metadata surface', () => {
  const facts = mapWebVideo(withPlayability({ status: 'LOGIN_REQUIRED', reason: '알 수 없는 새로운 로그인 제한' }), channel, id, { kind: 'skipped' }, 0);
  assert.equal(facts.access_status, 'public'); assert.equal(facts.availability, 'public');
  assert.deepEqual(playability({ status: 'LOGIN_REQUIRED', reason: '알 수 없는 새로운 로그인 제한' }), { kind: 'inconclusive', reason_code: 'unsupported_login_required_reason' });
});
test('age and region restrictions stay public with their availability; an explicit unlisted flag wins', () => {
  const age = mapWebVideo(withPlayability({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' }), channel, id, { kind: 'skipped' }, 0);
  assert.deepEqual([age.access_status, age.availability], ['public', 'age_restricted']);
  const unlisted = info(); (unlisted.page[0]!.microformat as Record<string, unknown>).is_unlisted = true;
  const facts = mapWebVideo(unlisted, channel, id, { kind: 'skipped' }, 0);
  assert.deepEqual([facts.access_status, facts.access_status_source, facts.availability], ['unlisted', 'youtubei:microformat', 'unlisted']);
});
test('members-only content is kept as a members-only video; without a public surface it settles as members_only', async () => {
  const members = await videoDetail(client({ WEB: withPlayability({ status: 'LOGIN_REQUIRED', reason: 'Join this channel to get access to members-only content' }) }) as never, channel, id, 0);
  assert.ok(!('unavailable' in members)); assert.equal(members.access_status, 'members_only'); assert.equal(members.is_members_only, true); assert.equal(members.availability, 'subscriber_only');
  const bare = await videoDetail(client({ WEB: { playability_status: { status: 'LOGIN_REQUIRED', reason: 'Members-only content' } } }) as never, channel, id, 0);
  assert.ok('unavailable' in bare); assert.equal(bare.access_status, 'members_only');
});
test('Video Detail recovers an uploader-removed terminal reason hidden by WEB', async () => {
  const calls: string[] = [];
  const web = Object.assign(new Error('This video is unavailable'), { info: { status: 'ERROR', reason: 'Video unavailable' } });
  const ios = Object.assign(new Error('This video is unavailable'), { info: { status: 'ERROR', reason: 'This video has been removed by the uploader' } });
  const video = await videoDetail(client({ WEB: web, IOS: ios }, calls) as never, channel, id, 0);
  assert.ok('unavailable' in video); assert.equal(video.access_status, 'removed'); assert.deepEqual(calls, ['WEB', 'IOS']);
  const copyright = await videoDetail(client({ WEB: { playability_status: { status: 'UNPLAYABLE', reason: 'This video is no longer available due to a copyright claim' } } }) as never, channel, id, 0);
  assert.ok('unavailable' in copyright); assert.equal(copyright.access_status, 'removed');
});
test('Video Detail does not run a terminal probe for an unrelated request failure', async () => {
  const calls: string[] = [];
  await assert.rejects(videoDetail(client({ WEB: new Error('socket connection reset by peer') }, calls) as never, channel, id, 0));
  assert.deepEqual(calls, ['WEB'], 'IOS is not asked to hide a route failure');
});
test('legacy classification order: members before private, age before removal wording', () => {
  assert.equal((playability({ status: 'UNPLAYABLE', reason: 'Private video for channel members' }) as { access?: string }).access, 'members_only');
  assert.equal((playability({ status: 'UNPLAYABLE', reason: 'Confirm your age; some videos have been removed' }) as { availability?: string }).availability, 'age_restricted');
  assert.equal((playability({ status: 'UNPLAYABLE', reason: 'This video is a YouTube Premium exclusive' }) as { access?: string }).access, 'members_only');
  assert.deepEqual(playability({ status: 'OK' }), { kind: 'content', access: 'public', availability: 'public', reason_code: 'playable' });
  assert.deepEqual(playability(undefined), { kind: 'inconclusive', reason_code: 'playability_unresolved' });
});
