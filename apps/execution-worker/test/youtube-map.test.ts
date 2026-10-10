import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRelative, parseCount, parseIsoDuration, parseKeywords, toChannelFacts, toVideoFacts, unavailableVideo, type AboutPage, type ApiChannel, type ApiVideo, type CommentsResult } from '../src/youtube/map.ts';
import { DataApi, DataApiError } from '../src/youtube/data-api.ts';
import { ScrapeError, topComments } from '../src/youtube/scrape.ts';
import type { Innertube } from 'youtubei.js';

const now = '2026-09-24T12:00:00.000Z';
const channel: ApiChannel = { id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', snippet: { title: 'Google for Developers', description: 'Build.', customUrl: '@googledevelopers', publishedAt: '2007-08-23T00:34:43Z', country: 'US', thumbnails: { high: { url: 'https://yt3.example/a.jpg' } } },
  statistics: { viewCount: '359612169', subscriberCount: '2670000', hiddenSubscriberCount: false, videoCount: '6097' }, brandingSettings: { channel: { keywords: '"google developers" android "machine learning"' } } };
const about: AboutPage = { country: 'United States', joined_text: 'Joined Aug 23, 2007', view_count_text: '359,612,169 views', subscriber_text: '2.67M subscribers', video_count_text: '6,097 videos',
  description: 'Build.', links: [{ title: 'TikTok', url: 'tiktok.com/@googlefordevs' }], business_email: false, tabs: ['Home', 'Videos', 'Shorts'], is_family_safe: true, is_verified: null };
const video = (extra: Partial<ApiVideo> = {}): ApiVideo => ({ id: 'YDCB8Bk1OBE', snippet: { channelId: channel.id, title: 'Gemma #AI', description: 'Talk #MachineLearning', publishedAt: '2026-09-22T23:00:10Z', tags: ['gemma'] },
  contentDetails: { duration: 'PT2M27S' }, statistics: { viewCount: '27464', likeCount: '287', commentCount: '15' }, status: { privacyStatus: 'public' }, ...extra });
const page: CommentsResult = { kind: 'page', total_text: '15', collected_at: now, comments: Array.from({ length: 3 }, (_, i) => ({ comment_id: `Ugx${i}abc`, text: `c${i}`, author_name: '@a', author_channel_id: 'UC_H0m3ZnoOc1sha091Wzf_w',
  author_url: 'https://www.youtube.com/@a', author_avatar_url: null, published_text: i === 0 ? '1 day ago (edited)' : '2 weeks ago', like_text: i === 0 ? '1.2K' : '3', reply_text: '0', is_pinned: i === 0, is_channel_owner: false, is_verified: false, is_hearted: false })) };

test('counts, durations, relative times and keywords parse without inventing precision', () => {
  assert.deepEqual(parseCount('2.67M subscribers'), { value: 2_670_000, exact: false });
  assert.deepEqual(parseCount('359,612,169 views'), { value: 359_612_169, exact: true });
  assert.deepEqual(parseCount('No views'), { value: 0, exact: true });
  assert.equal(parseCount(''), null); assert.equal(parseCount(null), null);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723); assert.equal(parseIsoDuration('P1DT2S'), 86402); assert.equal(parseIsoDuration('P0D'), null); assert.equal(parseIsoDuration('bogus'), null);
  assert.equal(estimateRelative('2 weeks ago', now), '2026-09-10T12:00:00.000Z'); assert.equal(estimateRelative('Streamed live', now), null);
  assert.deepEqual(parseKeywords('"google developers" android "machine learning"'), ['google developers', 'android', 'machine learning']);
});
test('channel facts carry sources and statuses; subscriber counts are estimates and hidden ones unavailable', () => {
  const facts = toChannelFacts(channel, about, now);
  assert.equal(facts.subscriber_count.status, 'estimated'); assert.equal(facts.total_view_count.status, 'exact'); assert.equal(facts.total_video_count.value, 6097);
  assert.equal(facts.country_code, 'US'); assert.equal(facts.country_source, 'data_api:snippet.country'); assert.equal(facts.joined_at, '2007-08-23');
  assert.deepEqual(facts.external_links, [{ title: 'TikTok', url: 'https://tiktok.com/@googlefordevs' }]);
  const hidden = toChannelFacts({ ...channel, statistics: { ...channel.statistics, hiddenSubscriberCount: true, subscriberCount: undefined } }, about, now);
  assert.deepEqual([hidden.subscriber_count.value, hidden.subscriber_count.status], [null, 'unavailable']);
});
test('video facts classify type, respect the comment limit and keep missing counts unavailable', () => {
  const v = toVideoFacts(video(), false, page, 2, now);
  assert.equal(v.content_type, 'video'); assert.equal(v.duration_seconds.value, 147); assert.deepEqual(v.hashtags, ['#AI', '#MachineLearning']);
  assert.equal(v.comments_first_page!.returned_count, 2); assert.equal(v.comments_first_page!.total_count, 15);
  const [first] = v.comments_first_page!.comments;
  assert.deepEqual([first!.like_count, first!.is_edited, first!.published_at_status, first!.published_at_utc], [1200, true, 'estimated_relative', '2026-09-23T12:00:00.000Z']);
  assert.equal(toVideoFacts(video(), true, page, 20, now).url, 'https://www.youtube.com/shorts/YDCB8Bk1OBE');
  assert.equal(toVideoFacts(video(), null, page, 20, now).content_type_source, 'default:shorts_unknown');
  const live = toVideoFacts(video({ liveStreamingDetails: { actualStartTime: '2026-09-22T23:00:00Z' }, contentDetails: { duration: 'P0D' }, snippet: { ...video().snippet, liveBroadcastContent: 'live' } }), false, { kind: 'skipped' }, 20, now);
  assert.deepEqual([live.content_type, live.duration_seconds.status, live.comments_first_page, live.comments_disabled], ['live', 'unavailable', null, null]);
  const hidden = toVideoFacts(video({ statistics: { viewCount: '5' } }), false, { kind: 'disabled', collected_at: now }, 20, now);
  assert.deepEqual([hidden.like_count.status, hidden.comment_count.status, hidden.comment_count.value, hidden.comments_disabled], ['unavailable', 'disabled', 0, true]);
  assert.equal(unavailableVideo(channel.id, 'abcdefghijk', now).unavailable, true);
});
test('an empty comment section keeps unknown counts unknown and preserves observed API counts', async () => {
  const yt = (message: string) => ({ getComments: async () => { throw new Error(message); } }) as unknown as Innertube;
  const empty = yt('The comments page did not have any content');
  assert.equal((await topComments(empty, 'YDCB8Bk1OBE', undefined)).kind, 'unavailable', 'an absent count is not evidence that comments are disabled');
  assert.deepEqual(await topComments(empty, 'YDCB8Bk1OBE', '0').then(r => r.kind === 'page' ? r.comments.length : r.kind), 0);
  const unavailable = await topComments(empty, 'YDCB8Bk1OBE', '15');
  assert.equal(unavailable.kind, 'unavailable', 'counted comments YouTube did not serve do not fail the batch');
  const facts = toVideoFacts(video(), false, unavailable, 20, now);
  assert.deepEqual([facts.comments_disabled, facts.comments_first_page, facts.comment_count.value, facts.comment_count.status], [null, null, 15, 'exact']);
  await assert.rejects(() => topComments(yt('Cannot read properties of undefined'), 'YDCB8Bk1OBE', '15'), (e: unknown) => e instanceof ScrapeError && e.kind === 'parse', 'other parse failures still fail');
  await assert.rejects(() => topComments(yt('Sign in to confirm you\u2019re not a bot'), 'YDCB8Bk1OBE', undefined), (e: unknown) => e instanceof ScrapeError && e.kind === 'blocked');
});
test('Data API listing stops at the window or the limit, pages through results, and hides the key in errors', async () => {
  const calls: string[] = [];
  const pages: Record<string, unknown> = {
    '': { items: [{ contentDetails: { videoId: 'a', videoPublishedAt: '2026-09-20T00:00:00Z' } }, { contentDetails: { videoId: 'private' } }, { contentDetails: { videoId: 'b', videoPublishedAt: '2026-08-01T00:00:00Z' } }], nextPageToken: 'P2' },
    P2: { items: [{ contentDetails: { videoId: 'c', videoPublishedAt: '2026-07-01T00:00:00Z' } }, { contentDetails: { videoId: 'old', videoPublishedAt: '2026-01-01T00:00:00Z' } }] } };
  const fetcher = (async (url: URL) => { calls.push(url.searchParams.get('pageToken') ?? ''); return Response.json(pages[url.searchParams.get('pageToken') ?? '']); }) as unknown as typeof fetch;
  const api = new DataApi('AIzaTEST_key_0123456789abcdef', fetcher);
  assert.deepEqual(await api.recentUploads('UUx', '2026-06-26T12:00:00.000Z', 30), { ids: ['a', 'b', 'c'], exhausted: true });
  assert.deepEqual(await api.recentUploads('UUx', '2026-06-26T12:00:00.000Z', 2), { ids: ['a', 'b'], exhausted: false });
  assert.equal(api.units, 3);
  const quota = new DataApi('AIzaTEST_key_0123456789abcdef', (async () => Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(quota.channel('UCx'), (e: unknown) => e instanceof DataApiError && e.kind === 'quota' && !e.message.includes('AIza'));
});
test('every Data API request waits for its quota permit, and a refused permit sends nothing', async () => {
  let requests = 0, permits = 0;
  const fetcher = (async (url: URL) => { requests += 1; return Response.json(url.pathname.endsWith('playlistItems')
    ? (url.searchParams.get('pageToken') ? { items: [] } : { items: [{ contentDetails: { videoId: 'a', videoPublishedAt: '2026-09-20T00:00:00Z' } }], nextPageToken: 'P2' })
    : { items: [] }); }) as unknown as typeof fetch;
  const api = new DataApi('AIzaTEST_key_0123456789abcdef', fetcher), permit = { async permit() { permits += 1; return undefined; } };
  await api.channel('UCx', permit); await api.recentUploads('UUx', '2026-06-26T12:00:00.000Z', 30, permit); await api.videos(['a'], permit);
  assert.deepEqual([permits, requests], [4, 4], 'one permit per request, the second listing page included');
  const refused = { async permit(): Promise<undefined> { throw new Error('BUDGET_EXHAUSTED'); } };
  await assert.rejects(api.channel('UCx', refused), /BUDGET_EXHAUSTED/);
  assert.equal(requests, 4, 'no request without a permit');
});
test('incremental discovery stops at the newest known video, at the end of the uploads, or keeps the newest 30 after 100', async () => {
  const page = (ids: string[], next?: string) => ({ items: ids.map(id => ({ contentDetails: { videoId: id, videoPublishedAt: id === 'private' ? undefined : '2026-10-01T00:00:00Z' } })), ...(next ? { nextPageToken: next } : {}) });
  const fetcherOf = (pages: Record<string, unknown>) => (async (url: URL) => Response.json(pages[url.searchParams.get('pageToken') ?? ''])) as unknown as typeof fetch;
  const key = 'AIzaTEST_key_0123456789abcdef';
  const anchored = await new DataApi(key, fetcherOf({ '': page(['n1', 'private', 'n2', 'known', 'older']) })).uploadsUntilAnchor('UUx', ['known', 'other']);
  assert.deepEqual(anchored, { ids: ['n1', 'n2'], pages: 1, scanned: 2, matched_anchor_id: 'known', stop_reason: 'anchor_matched' });
  const ended = await new DataApi(key, fetcherOf({ '': page(['a', 'b'], 'P2'), P2: page(['c']) })).uploadsUntilAnchor('UUx', []);
  assert.deepEqual(ended, { ids: ['a', 'b', 'c'], pages: 2, scanned: 3, matched_anchor_id: null, stop_reason: 'list_end' });
  const many = Array.from({ length: 150 }, (_, i) => `x${i}`);
  const gap = await new DataApi(key, fetcherOf({ '': page(many.slice(0, 50), 'P2'), P2: page(many.slice(50, 100), 'P3'), P3: page(many.slice(100), 'P4') })).uploadsUntilAnchor('UUx', ['never-seen']);
  assert.deepEqual([gap.ids, gap.pages, gap.scanned, gap.stop_reason], [many.slice(0, 30), 2, 100, 'gap_abandoned_latest_30']);
});
test('a failed Data API request is reported with its permit and reason', async () => {
  const failures: unknown[] = [];
  const guard = { async permit() { return 'permit-1'; }, async failed(id: string | undefined, endpoint: string, error: DataApiError) { failures.push([id, endpoint, error.kind]); } };
  const api = new DataApi('AIzaTEST_key_0123456789abcdef', (async () => Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(api.channel('UCx', guard), (e: unknown) => e instanceof DataApiError && e.kind === 'quota');
  assert.deepEqual(failures, [['permit-1', 'channels', 'quota']]);
});
