import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRelative, parseCount, parseIsoDuration, parseKeywords, toChannelFacts, toVideoFacts, unavailableVideo, type AboutPage, type ApiChannel, type ApiVideo, type CommentsResult } from '../src/youtube/map.ts';
import { DataApi, DataApiError } from '../src/youtube/data-api.ts';

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
