import { localizedEstimatedUtcTimestamp, parseLocalizedCountDetails } from './localized.ts';
import { ChannelFactsSchema, CommentPageSchema, VideoFactsSchema, VideoUnavailableSchema, type ChannelFacts, type VideoFacts, type VideoUnavailable } from '@crawlsystem/contracts';

// Pure mapping from upstream shapes (Data API v3 JSON, youtubei.js parsed nodes reduced
// to plain fields) into the shared contract. Every value says how it was obtained;
// nothing missing is filled with zero or an empty list pretending to be observed.
export const EXTRACTOR_VERSION = 'yt-collector/1 (youtubei.js 18.1.0 + data-api v3)';
type Metric = VideoFacts['view_count'];
const metric = (value: number | null, status: Metric['status'], source: string, observed_at: string): Metric => ({ value, status, source, observed_at });
/** A localized display count (legacy localizedCount.js rules); abbreviated values ("1.2K", "1,2 mil") are not exact. */
export function parseCount(text: string | null | undefined, locale = 'en'): { value: number; exact: boolean } | null {
  if (!text) return null;
  const parsed = parseLocalizedCountDetails(text, locale);
  if (parsed) return { value: parsed.value, exact: parsed.multiplier === 1 };
  // "No comments" / "No likes" in English carry no digits; kept from the previous English parser until the batch-3 comment rules.
  return locale.startsWith('en') && /\bno\b/i.test(text) ? { value: 0, exact: true } : null;
}
/** ISO 8601 duration (PT1H2M3S, P1DT2S) → seconds; P0D (upcoming live) → null. */
export function parseIsoDuration(text: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text ?? '');
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return seconds > 0 ? seconds : null;
}
/** "3 days ago" / "há 3 dias" relative to the observation time → estimated UTC timestamp (legacy localizedTime.js). */
export function estimateRelative(text: string, observedAt: string, locale = 'en'): string | null {
  return localizedEstimatedUtcTimestamp(text, locale, Date.parse(observedAt));
}
/** YouTube keyword strings quote multi-word terms: `"google developers" android`. */
/** Legacy keywordList (aboutCurrent.js:24-42): an array, a JSON array, or YouTube's quoted keyword string; unique and sorted. */
export function parseKeywords(value: unknown): string[] {
  const list = (items: unknown[]) => [...new Set(items.map(i => typeof i === 'string' ? i.trim() : '').filter(Boolean))].sort().slice(0, 100).map(k => k.slice(0, 200));
  if (Array.isArray(value)) return list(value);
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) { try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return list(parsed); } catch { /* YouTube's quoted syntax */ } }
  return list([...raw.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^,;\s]+)/g)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["'\\])/g, '$1')));
}
const textKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
/** Legacy normalizeVideoKeywords (videoMetadata.js:22-32): trimmed, first spelling kept, NFKC case-insensitive duplicates dropped. */
export function normalizeKeywords(...lists: (readonly unknown[] | undefined)[]): string[] {
  const seen = new Set<string>(), output: string[] = [];
  for (const value of lists.flatMap(list => list ?? [])) {
    if (typeof value !== 'string' || !value.trim() || seen.has(textKey(value.trim()))) continue;
    seen.add(textKey(value.trim())); output.push(value.trim().slice(0, 200));
  }
  return output.slice(0, 100);
}
/** Legacy extractVideoHashtags (videoMetadata.js:34-48): any non-word boundary, Unicode letters, marks and join controls. */
export function hashtags(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>(), output: string[] = [];
  for (const value of texts) for (const match of (value ?? '').matchAll(/(^|[^\p{L}\p{N}\p{M}\p{Join_Control}_])#([\p{L}\p{N}\p{M}\p{Join_Control}_]+)/gu)) {
    const tag = `#${match[2]}`;
    if (seen.has(textKey(tag))) continue;
    seen.add(textKey(tag)); output.push(tag.slice(0, 200));
  }
  return output.slice(0, 100);
}
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

/** Legacy channel API fallback: About facts from the Data API alone when the web page is unavailable but the channel exists. */
export function apiChannelFacts(api: ApiChannel, observed_at: string): ChannelFacts {
  const none: AboutPage = { country: null, joined_text: null, view_count_text: null, subscriber_text: null, video_count_text: null, description: null,
    links: [], business_email: false, tabs: [], is_family_safe: null, is_verified: null };
  return ChannelFactsSchema.parse({ ...toChannelFacts(api, none, observed_at), youtube_business_email_available: null, source: 'data_api:channels_fallback' });
}
/** Listed uploads stay with the collected channel; another owner (collaboration, the artist's VEVO channel) is recorded, not rejected. */
export function collectedFor(facts: VideoFacts, channelId: string): VideoFacts {
  return facts.channel_id === channelId ? facts : VideoFactsSchema.parse({ ...facts, channel_id: channelId, owner_channel_id: facts.channel_id });
}
export interface ApiVideo { id: string; snippet: { channelId: string; title: string; description?: string; publishedAt: string; tags?: string[]; thumbnails?: Record<string, { url: string }>; liveBroadcastContent?: string };
  contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; status?: { privacyStatus?: string };
  liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string; actualEndTime?: string } }
export interface ScrapedComment { comment_id: string; text: string; author_name: string | null; author_channel_id: string | null; author_url: string | null; author_avatar_url: string | null;
  published_text: string | null; like_text: string | null; reply_text: string | null; is_pinned: boolean | null; is_channel_owner: boolean | null; is_verified: boolean | null; is_hearted: boolean | null }
/** `unavailable`: the section exists (the API counts comments) but YouTube served none; facts keep the API count and no page. */
/** `surface: 'absent'` is a bare comment continuation: no comment section was served, which is not evidence of anything. */
export type CommentsResult = { kind: 'page'; total_text: string | null; comments: ScrapedComment[]; collected_at: string; sort?: 'TOP_COMMENTS' | 'NEWEST_FIRST'; locale?: string; surface?: 'available' | 'absent' }
  | { kind: 'disabled'; collected_at: string } | { kind: 'unavailable'; collected_at: string } | { kind: 'skipped' };
/** Evidence about the comment section observed outside the comment page itself. */
export interface CommentSignals {
  /** The count hint: the watch page's comment entry point, or the Data API statistics. */
  hint?: { value: number; source: string } | null;
  /** An explicit "comments are turned off" text on the watch page (legacy youtubeJs.js:1500-1504). */
  disabledMessage?: boolean;
  /** An empty comment response of an age-gated video (legacy isEmptyAgeGateCommentsResponse). */
  ageGate?: boolean;
  upcoming?: boolean; live?: boolean;
  /** Public or unlisted, as the web player decided; the Data API path reads its privacy status instead. */
  accessible?: boolean;
}
/** Legacy explicitDisabledSignal (youtubeCommentPage.js:95-110): disabled wording anywhere except the comment composer. */
export function disabledCommentsText(value: unknown): boolean {
  if (typeof value === 'string') return /comments? (?:are |have been )?(?:turned off|disabled)/i.test(value)
    || /coment[aá]rios? (?:foram |est[aã]o )?(?:desativad|desabilitad)/i.test(value) || /commentaires? (?:sont |ont [eé]t[eé] )?(?:d[eé]sactiv)/i.test(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(disabledCommentsText);
  return Object.entries(value).some(([key, child]) => key !== 'commentSimpleboxRenderer' && disabledCommentsText(child));
}
/**
 * Legacy classifyYoutubeCommentPage plus the video-level rules around it (youtubeCommentPage.js:519-567,
 * youtubeJs.js:1499-1576): disabled only without any returned comment; a read page counts exactly (an abbreviated
 * total is still exact; returned comments are a lower bound); an available but empty section is a policy zero; then the
 * hint; an age-gated empty response is disabled; an upcoming or live video without a section is a policy zero.
 */
export function classifyComments(comments: CommentsResult, total: number | null, signals: CommentSignals, accessible: boolean, observed_at: string): { comments_disabled: boolean | null; comment_count: Metric } {
  const read = comments.kind === 'page' ? comments.comments.length : 0;
  if (comments.kind === 'disabled' || read === 0 && signals.disabledMessage) return { comments_disabled: true, comment_count: metric(0, 'disabled', 'youtubei:comments', observed_at) };
  if (comments.kind === 'page') {
    if (read > 0 || total !== null && total > 0) return { comments_disabled: false, comment_count: metric(total ?? read, 'exact', 'youtubei:comments', observed_at) };
    if (total === 0 || comments.surface !== 'absent') return { comments_disabled: false, comment_count: metric(0, 'zero_from_surface', 'youtubei:comments', observed_at) };
  }
  if (signals.ageGate) return { comments_disabled: true, comment_count: metric(0, 'disabled', 'youtubei:comments_age_gate_empty', observed_at) };
  if (signals.hint) return { comments_disabled: false, comment_count: metric(signals.hint.value, 'exact', signals.hint.source, observed_at) };
  if (comments.kind === 'page' && accessible && (signals.upcoming || signals.live))
    return { comments_disabled: null, comment_count: signals.upcoming ? metric(0, 'zero_from_upcoming', 'youtubei:upcoming_comments_not_public', observed_at) : metric(0, 'zero_from_empty', 'youtubei:live_comments_not_public', observed_at) };
  return { comments_disabled: null, comment_count: metric(null, 'unresolved', 'youtubei:video', observed_at) };
}

export function toVideoFacts(api: ApiVideo, isShort: boolean | null, comments: CommentsResult, commentLimit: number, observed_at: string, signals: CommentSignals = {}): VideoFacts {
  const s = api.snippet, stats = api.statistics ?? {}, src = 'data_api:videos';
  const live = !!api.liveStreamingDetails;
  const content_type = live ? 'live' : isShort ? 'short' : 'video';
  const duration = parseIsoDuration(api.contentDetails?.duration);
  const count = (raw: string | undefined, missing: Metric['status']) => raw !== undefined ? metric(Number(raw), 'exact', src, observed_at) : metric(null, missing, src, observed_at);
  // Legacy Data API mapping (youtube.js:2135-2143): a public video without commentCount has its comments turned off,
  // unless the web comment page returned comments.
  const isPublic = api.status?.privacyStatus === 'public', returned = comments.kind === 'page' && comments.comments.length > 0;
  const apiDisabled = isPublic && stats.commentCount === undefined && !returned;
  const hint = signals.hint !== undefined ? signals.hint : stats.commentCount !== undefined ? { value: Number(stats.commentCount), source: 'data_api:statistics' } : null;
  // Legacy normalizeYoutubeCommentPage dedupes by comment id and renumbers (youtubeCommentPage.js:424-427).
  const unique = comments.kind === 'page' ? comments.comments.filter((c, i, all) => all.findIndex(o => o.comment_id === c.comment_id) === i) : [];
  const total = comments.kind === 'page' ? parseCount(comments.total_text, comments.locale)?.value ?? null : null;
  const classified = apiDisabled ? { comments_disabled: true, comment_count: metric(0, 'disabled', 'data_api:statistics', observed_at) }
    : classifyComments(comments.kind === 'page' ? { ...comments, comments: unique } : comments, total, { ...signals, hint }, signals.accessible ?? ['public', 'unlisted'].includes(api.status?.privacyStatus ?? ''), observed_at);
  const disabled = classified.comments_disabled === true;
  const page = comments.kind === 'page' ? CommentPageSchema.parse({ version: 1, collected_at: comments.collected_at, sort: comments.sort ?? 'TOP_COMMENTS',
    total_count: total ?? hint?.value ?? null,
    returned_count: Math.min(unique.length, commentLimit), comments: unique.slice(0, commentLimit).map((c, i) => {
      const estimated = c.published_text ? estimateRelative(c.published_text, comments.collected_at, comments.locale) : null;
      return { comment_id: c.comment_id, position: i + 1, text: c.text.slice(0, 20_000), author_name: c.author_name, author_channel_id: c.author_channel_id, author_url: c.author_url, author_avatar_url: c.author_avatar_url,
        published_at_utc: estimated, published_text_raw: c.published_text, published_at_status: estimated ? 'estimated_relative' : 'unresolved',
        is_edited: c.published_text ? /edited|editado/i.test(c.published_text) : null, like_count: parseCount(c.like_text, comments.locale)?.value ?? null, reply_count: parseCount(c.reply_text, comments.locale)?.value ?? null,
        is_pinned: c.is_pinned, is_channel_owner: c.is_channel_owner, is_verified: c.is_verified, is_hearted: c.is_hearted };
    }) }) : null;
  return VideoFactsSchema.parse({
    channel_id: s.channelId, source_content_id: api.id, content_type,
    content_type_source: live ? 'data_api:liveStreamingDetails' : isShort === null ? 'default:shorts_unknown' : 'youtubei:shorts_tab',
    url: content_type === 'short' ? `https://www.youtube.com/shorts/${api.id}` : `https://www.youtube.com/watch?v=${api.id}`,
    // Legacy descriptionState: an observed empty description stays '' (delivered as empty), only an unobserved one is null.
    title: s.title || '(untitled)', description: typeof s.description === 'string' ? (s.description.trim() ? s.description.slice(0, 20_000) : '') : null, thumbnail_url: bestThumb(s.thumbnails),
    keywords: normalizeKeywords(s.tags), hashtags: hashtags(s.title, s.description),
    published_at: s.publishedAt, published_text_raw: s.publishedAt, published_at_status: 'exact', published_at_precision: 'second', published_at_source: src,
    duration_seconds: duration !== null ? metric(duration, 'exact', src, observed_at) : metric(null, s.liveBroadcastContent === 'upcoming' || s.liveBroadcastContent === 'live' ? 'unavailable' : 'unresolved', src, observed_at),
    view_count: count(stats.viewCount, 'unavailable'),
    // Legacy detailPolicy.js:93-102: a public video without a like count has hidden likes, a policy zero.
    like_count: stats.likeCount === undefined && isPublic ? metric(0, 'zero_from_empty', 'public_empty_is_zero', observed_at) : count(stats.likeCount, 'unavailable'),
    comment_count: classified.comment_count, comments_disabled: classified.comments_disabled,
    comments_first_page: disabled ? { version: 1, collected_at: 'collected_at' in comments ? comments.collected_at : observed_at, sort: 'TOP_COMMENTS', total_count: 0, returned_count: 0, comments: [] } : page,
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
