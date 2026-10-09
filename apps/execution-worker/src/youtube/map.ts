import { ChannelFactsSchema, CommentPageSchema, VideoFactsSchema, VideoUnavailableSchema, type ChannelFacts, type VideoFacts, type VideoUnavailable } from '@crawlsystem/contracts';

// Pure mapping from upstream shapes (Data API v3 JSON, youtubei.js parsed nodes reduced
// to plain fields) into the shared contract. Every value says how it was obtained;
// nothing missing is filled with zero or an empty list pretending to be observed.
export const EXTRACTOR_VERSION = 'yt-collector/1 (youtubei.js 18.1.0 + data-api v3)';
type Metric = VideoFacts['view_count'];
const metric = (value: number | null, status: Metric['status'], source: string, observed_at: string): Metric => ({ value, status, source, observed_at });
/** "2.67M subscribers" / "359,612,169 views" / "1.2K" → number; K/M/B abbreviations are estimates. */
export function parseCount(text: string | null | undefined): { value: number; exact: boolean } | null {
  if (!text) return null;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/ /g, ' '));
  if (!m) return /\bno\b/i.test(text) ? { value: 0, exact: true } : null;
  const unit = m[2]?.toUpperCase(), number = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  return unit ? { value: Math.round(number * { K: 1e3, M: 1e6, B: 1e9 }[unit as 'K']), exact: false } : { value: Math.round(number), exact: true };
}
/** ISO 8601 duration (PT1H2M3S, P1DT2S) → seconds; P0D (upcoming live) → null. */
export function parseIsoDuration(text: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text ?? '');
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return seconds > 0 ? seconds : null;
}
/** "3 days ago" relative to the observation time → estimated UTC timestamp. */
export function estimateRelative(text: string, observedAt: string): string | null {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (!m) return null;
  const unitMs = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2]!.toLowerCase() as 'day'];
  return new Date(Date.parse(observedAt) - Number(m[1]) * unitMs).toISOString();
}
/** YouTube keyword strings quote multi-word terms: `"google developers" android`. */
export function parseKeywords(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] ?? m[2])!.trim()).filter(Boolean).slice(0, 100).map(k => k.slice(0, 200));
}
const hashtags = (...texts: (string | undefined)[]) => [...new Set(texts.flatMap(t => [...(t ?? '').matchAll(/(^|\s)(#[\p{L}\p{N}_]{1,100})/gu)].map(m => m[2]!)))].slice(0, 100);
const bestThumb = (thumbs: Record<string, { url: string }> | undefined) => thumbs ? (thumbs.maxres ?? thumbs.standard ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null : null;
const absolute = (link: string) => /^https?:\/\//i.test(link) ? link : `https://${link}`;

export interface ApiChannel { id: string; snippet: { title: string; description?: string; customUrl?: string; publishedAt?: string; country?: string; thumbnails?: Record<string, { url: string }> };
  statistics?: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string }; brandingSettings?: { channel?: { keywords?: string } }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }
/** The About page as scraped (youtubei AboutChannelView reduced to strings). */
export interface AboutPage { country: string | null; joined_text: string | null; view_count_text: string | null; subscriber_text: string | null; video_count_text: string | null;
  description: string | null; links: { title: string; url: string }[]; business_email: boolean; tabs: string[]; is_family_safe: boolean | null; is_verified: boolean | null }

export function toChannelFacts(api: ApiChannel, about: AboutPage, observed_at: string): ChannelFacts {
  const stats = api.statistics ?? {}, api_src = 'data_api:channels', about_src = 'youtubei:about';
  const subscribers = stats.hiddenSubscriberCount ? metric(null, 'unavailable', api_src, observed_at)
    // The API rounds subscriber counts to three significant figures.
    : stats.subscriberCount !== undefined ? metric(Number(stats.subscriberCount), 'estimated', api_src, observed_at) : metric(null, 'unresolved', api_src, observed_at);
  const views = stats.viewCount !== undefined ? metric(Number(stats.viewCount), 'exact', api_src, observed_at)
    : (() => { const p = parseCount(about.view_count_text); return p ? metric(p.value, p.exact ? 'exact' : 'estimated', about_src, observed_at) : metric(null, 'unresolved', api_src, observed_at); })();
  const videos = stats.videoCount !== undefined ? metric(Number(stats.videoCount), 'exact', api_src, observed_at) : metric(null, 'unresolved', api_src, observed_at);
  return ChannelFactsSchema.parse({
    channel_id: api.id, channel_url: `https://www.youtube.com/channel/${api.id}`, title: api.snippet.title,
    handle: api.snippet.customUrl ?? null, avatar_url: bestThumb(api.snippet.thumbnails), summary: null,
    about_description: api.snippet.description || about.description || null,
    country: about.country, country_code: api.snippet.country ?? null,
    country_source: api.snippet.country ? 'data_api:snippet.country' : about.country ? about_src : null,
    joined_at: api.snippet.publishedAt ? api.snippet.publishedAt.slice(0, 10) : null, joined_date_text: about.joined_text,
    joined_at_precision: api.snippet.publishedAt ? 'date_only' : 'unknown',
    keywords: parseKeywords(api.brandingSettings?.channel?.keywords), available_tabs: about.tabs.slice(0, 20),
    external_links: about.links.slice(0, 100).map(l => ({ title: l.title.slice(0, 500), url: absolute(l.url) })),
    subscriber_count: subscribers, total_view_count: views, total_video_count: videos,
    is_verified: about.is_verified, is_family_safe: about.is_family_safe, youtube_business_email_available: about.business_email,
    observed_at, source: 'data_api+youtubei',
  });
}

export interface ApiVideo { id: string; snippet: { channelId: string; title: string; description?: string; publishedAt: string; tags?: string[]; thumbnails?: Record<string, { url: string }>; liveBroadcastContent?: string };
  contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; status?: { privacyStatus?: string };
  liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string; actualEndTime?: string } }
export interface ScrapedComment { comment_id: string; text: string; author_name: string | null; author_channel_id: string | null; author_url: string | null; author_avatar_url: string | null;
  published_text: string | null; like_text: string | null; reply_text: string | null; is_pinned: boolean | null; is_channel_owner: boolean | null; is_verified: boolean | null; is_hearted: boolean | null }
/** `unavailable`: the section exists (the API counts comments) but YouTube served none; facts keep the API count and no page. */
export type CommentsResult = { kind: 'page'; total_text: string | null; comments: ScrapedComment[]; collected_at: string } | { kind: 'disabled'; collected_at: string }
  | { kind: 'unavailable'; collected_at: string } | { kind: 'skipped' };

export function toVideoFacts(api: ApiVideo, isShort: boolean | null, comments: CommentsResult, commentLimit: number, observed_at: string): VideoFacts {
  const s = api.snippet, stats = api.statistics ?? {}, src = 'data_api:videos';
  const live = !!api.liveStreamingDetails;
  const content_type = live ? 'live' : isShort ? 'short' : 'video';
  const duration = parseIsoDuration(api.contentDetails?.duration);
  const count = (raw: string | undefined, missing: Metric['status']) => raw !== undefined ? metric(Number(raw), 'exact', src, observed_at) : metric(null, missing, src, observed_at);
  const disabled = comments.kind === 'disabled';
  const page = comments.kind === 'page' ? CommentPageSchema.parse({ version: 1, collected_at: comments.collected_at, sort: 'TOP_COMMENTS',
    total_count: parseCount(comments.total_text)?.value ?? (stats.commentCount !== undefined ? Number(stats.commentCount) : null),
    returned_count: Math.min(comments.comments.length, commentLimit), comments: comments.comments.slice(0, commentLimit).map((c, i) => {
      const estimated = c.published_text ? estimateRelative(c.published_text, comments.collected_at) : null;
      return { comment_id: c.comment_id, position: i + 1, text: c.text.slice(0, 20_000), author_name: c.author_name, author_channel_id: c.author_channel_id, author_url: c.author_url, author_avatar_url: c.author_avatar_url,
        published_at_utc: estimated, published_text_raw: c.published_text, published_at_status: estimated ? 'estimated_relative' : 'unresolved',
        is_edited: c.published_text ? /edited/i.test(c.published_text) : null, like_count: parseCount(c.like_text)?.value ?? null, reply_count: parseCount(c.reply_text)?.value ?? null,
        is_pinned: c.is_pinned, is_channel_owner: c.is_channel_owner, is_verified: c.is_verified, is_hearted: c.is_hearted };
    }) }) : null;
  return VideoFactsSchema.parse({
    channel_id: s.channelId, source_content_id: api.id, content_type,
    content_type_source: live ? 'data_api:liveStreamingDetails' : isShort === null ? 'default:shorts_unknown' : 'youtubei:shorts_tab',
    url: content_type === 'short' ? `https://www.youtube.com/shorts/${api.id}` : `https://www.youtube.com/watch?v=${api.id}`,
    title: s.title || '(untitled)', description: s.description || null, thumbnail_url: bestThumb(s.thumbnails),
    keywords: (s.tags ?? []).slice(0, 100).map(t => t.slice(0, 200)), hashtags: hashtags(s.title, s.description),
    published_at: s.publishedAt, published_text_raw: s.publishedAt, published_at_status: 'exact', published_at_precision: 'second', published_at_source: src,
    duration_seconds: duration !== null ? metric(duration, 'exact', src, observed_at) : metric(null, s.liveBroadcastContent === 'upcoming' || s.liveBroadcastContent === 'live' ? 'unavailable' : 'unresolved', src, observed_at),
    view_count: count(stats.viewCount, 'unavailable'), like_count: count(stats.likeCount, 'unavailable'),
    comment_count: disabled ? metric(0, 'disabled', 'youtubei:comments', observed_at) : count(stats.commentCount, 'unavailable'),
    comments_disabled: disabled ? true : comments.kind === 'page' ? false : null, comments_first_page: disabled ? { version: 1, collected_at: comments.collected_at, sort: 'TOP_COMMENTS', total_count: 0, returned_count: 0, comments: [] } : page,
    access_status: api.status?.privacyStatus === 'unlisted' ? 'unlisted' : api.status?.privacyStatus === 'private' ? 'private' : api.status?.privacyStatus === 'public' ? 'public' : 'unknown',
    access_status_source: 'data_api:status.privacyStatus', is_members_only: false,
    live_scheduled_at: api.liveStreamingDetails?.scheduledStartTime ?? null, live_started_at: api.liveStreamingDetails?.actualStartTime ?? null, live_ended_at: api.liveStreamingDetails?.actualEndTime ?? null,
    observed_at, extractor_version: EXTRACTOR_VERSION,
  });
}
/** A frozen target the Data API no longer returns (private, deleted, or otherwise restricted). */
export function unavailableVideo(channel_id: string, id: string, observed_at: string): VideoUnavailable {
  return VideoUnavailableSchema.parse({ channel_id, source_content_id: id, unavailable: true, access_status: 'unavailable',
    reason: 'Listed as an upload but not returned by the Data API videos endpoint (private, removed or restricted)', source: 'data_api:videos', observed_at });
}

/** A search candidate's qualification facts from the Data API (hidden subscriber counts stay unknown). */
export function toCandidateFacts(api: ApiChannel) {
  const stats = api.statistics ?? {}, count = (v?: string) => v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
  return { channel_id: api.id, title: api.snippet.title?.slice(0, 300) ?? null, country: api.snippet.country?.slice(0, 10) ?? null,
    subscriber_count: stats.hiddenSubscriberCount ? null : count(stats.subscriberCount), hidden_subscribers: stats.hiddenSubscriberCount === true,
    video_count: count(stats.videoCount), view_count: count(stats.viewCount) };
}
