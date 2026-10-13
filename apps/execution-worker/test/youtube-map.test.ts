import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyComments, disabledCommentsText, estimateRelative, hashtags, normalizeKeywords, parseCount, parseIsoDuration, parseKeywords, toChannelFacts, toVideoFacts, unavailableVideo, type AboutPage, type ApiChannel, type ApiVideo, type CommentsResult } from '../src/youtube/map.ts';
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
  // Units captured before 10-13 hold pt-BR text and are read in pt-BR (legacy localizedTime.js); English rules do not guess it.
  assert.equal(estimateRelative('há 2 semanas', now, 'pt-BR'), '2026-09-10T12:00:00.000Z'); assert.equal(estimateRelative('há 2 semanas', now, 'en'), null);
  assert.deepEqual(parseCount('1,2 mil', 'pt-BR'), { value: 1_200, exact: false });
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
test('video facts classify type, respect the comment limit and record hidden public likes as a policy zero', () => {
  const v = toVideoFacts(video(), false, page, 2, now);
  assert.equal(v.content_type, 'video'); assert.equal(v.duration_seconds.value, 147); assert.deepEqual(v.hashtags, ['#AI', '#MachineLearning']);
  assert.equal(v.comments_first_page!.returned_count, 2); assert.equal(v.comments_first_page!.total_count, 15);
  const [first] = v.comments_first_page!.comments;
  assert.deepEqual([first!.like_count, first!.is_edited, first!.published_at_status, first!.published_at_utc], [1200, true, 'estimated_relative', '2026-09-23T12:00:00.000Z']);
  assert.equal(toVideoFacts(video(), true, page, 20, now).url, 'https://www.youtube.com/shorts/YDCB8Bk1OBE');
  assert.equal(toVideoFacts(video(), null, page, 20, now).content_type_source, 'default:shorts_unknown');
  const live = toVideoFacts(video({ liveStreamingDetails: { actualStartTime: '2026-09-22T23:00:00Z' }, contentDetails: { duration: 'P0D' }, snippet: { ...video().snippet, liveBroadcastContent: 'live' } }), false, { kind: 'skipped' }, 20, now);
  // Legacy youtubeJs.js:1524-1527: a known comment count means comments are not turned off.
  assert.deepEqual([live.content_type, live.duration_seconds.status, live.comments_first_page, live.comments_disabled], ['live', 'unavailable', null, false]);
  const hidden = toVideoFacts(video({ statistics: { viewCount: '5' } }), false, { kind: 'disabled', collected_at: now }, 20, now);
  // Legacy missingLikeIsZero: a public video without likeCount has hidden likes.
  assert.deepEqual([hidden.like_count.status, hidden.comment_count.status, hidden.comment_count.value, hidden.comments_disabled], ['zero_from_empty', 'disabled', 0, true]);
  assert.equal(unavailableVideo(channel.id, 'abcdefghijk', now).unavailable, true);
});
test('an empty comment section keeps unknown counts unknown and preserves observed API counts', async () => {
  const yt = (message: string) => ({ getComments: async () => { throw new Error(message); } }) as unknown as Innertube;
  const empty = yt('The comments page did not have any content');
  const absent = await topComments(empty, 'YDCB8Bk1OBE', undefined);
  assert.ok(absent.kind === 'page' && absent.surface === 'absent', 'a bare continuation is an absent surface');
  const unknown = toVideoFacts(video({ statistics: { viewCount: '1', likeCount: '1' }, status: undefined } as never), false, absent, 20, now);
  assert.deepEqual([unknown.comments_disabled, unknown.comment_count.value, unknown.comment_count.status], [null, null, 'unresolved'], 'an absent section with no count is not evidence that comments are disabled');
  // Legacy M-30: a zero hint with an empty response is a zero count, not a lost one.
  const zero = toVideoFacts(video({ statistics: { viewCount: '1', likeCount: '1', commentCount: '0' } }), false, await topComments(empty, 'YDCB8Bk1OBE', '0'), 20, now);
  assert.deepEqual([zero.comments_disabled, zero.comment_count.value, zero.comment_count.status], [false, 0, 'exact']);
  const counted = toVideoFacts(video(), false, await topComments(empty, 'YDCB8Bk1OBE', '15'), 20, now);
  assert.deepEqual([counted.comments_disabled, counted.comments_first_page?.returned_count, counted.comment_count.value, counted.comment_count.status], [false, 0, 15, 'exact'], 'counted comments YouTube did not serve keep the observed count');
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
test('Data API: a public video without likeCount is a policy zero; without commentCount its comments are off unless the web page was read', () => {
  const bare = video({ statistics: { viewCount: '10' }, status: { privacyStatus: 'public' } } as never);
  const v = toVideoFacts(bare, false, { kind: 'skipped' }, 20, now);
  assert.deepEqual([v.like_count.value, v.like_count.status, v.like_count.source], [0, 'zero_from_empty', 'public_empty_is_zero']);
  assert.deepEqual([v.comment_count.value, v.comment_count.status, v.comment_count.source, v.comments_disabled], [0, 'disabled', 'data_api:statistics', true]);
  const read = toVideoFacts(bare, false, page, 20, now);
  assert.equal(read.comments_disabled, false, 'a comment page read on the web wins over the missing API count');
  const unknown = toVideoFacts(video({ statistics: { viewCount: '10' }, status: undefined } as never), false, { kind: 'skipped' }, 20, now);
  assert.deepEqual([unknown.like_count.status, unknown.comments_disabled], ['unavailable', null], 'without a privacy status nothing is inferred');
});
// Ported from oldsystem qybullmq/test/videoMetadata.test.js (batch 2e).
test('extractVideoHashtags reads title and description with Unicode support and join controls', () => {
  assert.deepEqual(hashtags('Short #Roblox #话题', 'More #roblox #maquillaje_2026 #한글'), ['#Roblox', '#话题', '#maquillaje_2026', '#한글']);
  assert.deepEqual(hashtags('#می‌خواهم #क्‍षेत्र'), ['#می‌خواهم', '#क्‍षेत्र']);
  assert.deepEqual(hashtags('end.#tag (#two)'), ['#tag', '#two'], 'any non-word character is a boundary');
});
test('normalizeVideoKeywords preserves source order and removes case duplicates', () => {
  assert.deepEqual(normalizeKeywords(['Roblox', 'Brookhaven'], ['roblox', 'Shorts']), ['Roblox', 'Brookhaven', 'Shorts']);
});
test('descriptionState distinguishes a legitimate empty description from an unobserved one', () => {
  assert.equal(toVideoFacts(video({ snippet: { ...video().snippet, description: '' } }), false, { kind: 'skipped' }, 20, now).description, '');
  assert.equal(toVideoFacts(video({ snippet: { ...video().snippet, description: undefined } }), false, { kind: 'skipped' }, 20, now).description, null);
});
// Ported from oldsystem qybullmq/test/youtubeCommentPage.test.js and youtubeJs.test.js (batch 3a).
const cpage = (comments: number, total: string | null, surface: 'available' | 'absent' = 'available'): CommentsResult => ({ kind: 'page', total_text: total, collected_at: now, locale: 'en', surface,
  comments: Array.from({ length: comments }, (_, i) => ({ comment_id: `Ugz${i}xyz`, text: 't', author_name: null, author_channel_id: null, author_url: null, author_avatar_url: null, published_text: null, like_text: null, reply_text: null, is_pinned: null, is_channel_owner: null, is_verified: null, is_hearted: null })) });
test('youtubeCommentsDisabled recognizes an explicit disabled surface but never over returned comments or the composer', () => {
  assert.equal(disabledCommentsText(['Comments are turned off. Learn more']), true);
  assert.equal(disabledCommentsText(['Os comentários estão desativados.']), true);
  assert.equal(disabledCommentsText({ commentSimpleboxRenderer: { disabledText: 'Comments are disabled for this video' } }), false, 'an inactive composer is not a disabled surface');
  const off = classifyComments(cpage(0, null, 'absent'), null, { disabledMessage: true }, true, now);
  assert.deepEqual([off.comments_disabled, off.comment_count.value, off.comment_count.status], [true, 0, 'disabled']);
  assert.equal(classifyComments(cpage(2, '2'), 2, { disabledMessage: true }, true, now).comments_disabled, false, 'returned comments win over disabled wording');
});
test('classifyYoutubeCommentPage keeps closed, zero and positive totals distinct; abbreviated totals stay exact', () => {
  const first = classifyComments(cpage(3, null), null, {}, true, now);
  assert.deepEqual([first.comment_count.value, first.comment_count.status, first.comments_disabled], [3, 'exact', false], 'returned comments are a lower bound');
  assert.deepEqual(classifyComments(cpage(20, '1.2K'), 1_200, {}, true, now).comment_count.status, 'exact', 'legacy has no estimated comment count');
  const zero = classifyComments(cpage(0, null), null, {}, true, now);
  assert.deepEqual([zero.comment_count.value, zero.comment_count.status, zero.comments_disabled], [0, 'zero_from_surface', false]);
  const bare = classifyComments(cpage(0, null, 'absent'), null, {}, true, now);
  assert.deepEqual([bare.comment_count.status, bare.comments_disabled], ['unresolved', null], 'a successful bare continuation stays unresolved');
});
test('an empty comments endpoint resolves an age-gated video as disabled; live comment surfaces are policy zeros', () => {
  const age = classifyComments(cpage(0, null, 'absent'), null, { ageGate: true }, true, now);
  assert.deepEqual([age.comments_disabled, age.comment_count.status, age.comment_count.source], [true, 'disabled', 'youtubei:comments_age_gate_empty']);
  const upcoming = classifyComments(cpage(0, null, 'absent'), null, { upcoming: true }, true, now);
  assert.deepEqual([upcoming.comment_count.value, upcoming.comment_count.status, upcoming.comments_disabled], [0, 'zero_from_upcoming', null], 'absent live comments are not disabled comments');
  assert.equal(classifyComments(cpage(0, null, 'absent'), null, { live: true }, true, now).comment_count.status, 'zero_from_empty');
  assert.equal(classifyComments(cpage(0, null, 'absent'), null, { live: true }, false, now).comment_count.status, 'unresolved', 'restricted videos get no policy zero');
});
test('duplicate comment ids are dropped and positions renumbered instead of failing the video', () => {
  const dup = cpage(2, '5'); if (dup.kind === 'page') dup.comments.push({ ...dup.comments[0]! });
  const v = toVideoFacts(video(), false, dup, 20, now);
  assert.deepEqual(v.comments_first_page!.comments.map(c => [c.comment_id, c.position]), [['Ugz0xyz', 1], ['Ugz1xyz', 2]]);
});
