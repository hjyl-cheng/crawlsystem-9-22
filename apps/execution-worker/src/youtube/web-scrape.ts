import { Innertube, YTNodes } from 'youtubei.js';
import { ChannelFactsSchema, VideoFactsSchema, VideoUnavailableSchema, type ChannelFacts, type VideoFacts, type VideoItem } from '@crawlsystem/contracts';
import { ScrapeError, topComments, classify } from './scrape.ts';
import { disabledCommentsText, normalizeKeywords, parseCount, parseKeywords, toVideoFacts, type CommentsResult } from './map.ts';
import { findSubscriberCountText, localizedAbsoluteUtcDay } from './localized.ts';
import type { BrowserIdentity } from './identity.ts';
import { IDENTITY_POLICY } from './identity.ts';
import type { UploadDiscovery } from './data-api.ts';
import type { RawResponse } from '../raw-archive.ts';

// Parsed YouTube.js nodes change between versions. Keep their dynamic shapes inside this adapter.
type Node = Record<string, any>;
const text = (value: unknown): string | null => { const s = value?.toString(); return s && !['[object Object]', 'N/A'].includes(s) ? s : null; };
/** Texts are parsed in the language of the capturing session (legacy: every count and date in DEFAULT_LANGUAGE). */
export const SESSION_LOCALE: string = IDENTITY_POLICY.language;
/** An integer is exact; display text is parsed in the session language, and an abbreviation ("1.2M") is not exact. */
const countDetail = (value: unknown, locale: string): { value: number; exact: boolean } | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { value, exact: true } : parseCount(text(value), locale);
const count = (value: unknown, locale: string) => countDetail(value, locale)?.value ?? null;
/** Legacy youtubeJsLikeCount (youtubeJs.js:1446-1466): the exact count YouTube.js read from the button, then the button
 * text; a button whose title and accessibility text are both just "Like" hides its count, a policy zero. */
function likeCount(info: Node, locale: string): { value: number | null; status?: 'zero_from_empty'; source: string } {
  const basic = info.basic_info?.like_count;
  if (typeof basic === 'number' && Number.isSafeInteger(basic) && basic >= 0) return { value: basic, source: 'youtubei:next' };
  const segmented = (info.primary_info?.menu?.top_level_buttons ?? []).find((b: Node) => b?.like_button || /LikeDislike/i.test(String(b?.type ?? '')));
  const button = segmented?.like_button?.toggle_button?.default_button;
  for (const candidate of [segmented?.like_count, segmented?.short_like_count, button?.title]) {
    const value = count(candidate, locale);
    if (value !== null) return { value, source: 'youtubei:next_button' };
  }
  if (text(button?.title) === 'Like' && text(button?.accessibility_text) === 'Like') return { value: 0, status: 'zero_from_empty', source: 'youtubei:like_count_not_public' };
  return { value: null, source: 'youtubei:video' };
}
const thumb = (values: Node[] | undefined) => values?.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;
/** Legacy bestThumbnail (youtubeJs.js:205-227): the largest area across every source, as an absolute URL; none is null. */
function largestThumbnail(...values: unknown[]): string | null {
  const found: { url: string; area: number }[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const node = value as Node;
    if (typeof node.url === 'string') found.push({ url: new URL(node.url, 'https://www.youtube.com').toString(), area: Number(node.width || 0) * Number(node.height || 0) });
    for (const key of ['thumbnails', 'thumbnail', 'image', 'sources', 'content_image', 'contentImage']) if (node[key] && node[key] !== node) visit(node[key], depth + 1);
  };
  for (const value of values) visit(value);
  return found.sort((a, b) => b.area - a.area)[0]?.url ?? null;
}
function strings(value: unknown, depth = 0): string[] {
  if (!value || depth > 9) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  const rendered = text(value);
  if (rendered && !rendered.includes('[object Object]') && !Array.isArray(value)) return [rendered];
  return Object.values(value).slice(0, 60).flatMap(v => strings(v, depth + 1));
}
/** ISO timestamps keep second precision; localized display dates ("Aug 18, 2026", "18 de ago. de 2026") resolve to a UTC day (legacy localizedTime.js). */
export function absoluteDate(value: unknown, locale: string = SESSION_LOCALE): { value: string | null; precision: 'second' | 'date_only' | 'unknown' } {
  const raw = text(value) ?? '';
  const iso = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isFinite(iso)) return { value: new Date(iso).toISOString(), precision: raw.includes('T') ? 'second' : 'date_only' };
  const day = localizedAbsoluteUtcDay(raw, locale);
  return day ? { value: `${day}T00:00:00.000Z`, precision: 'date_only' } : { value: null, precision: 'unknown' };
}
/** `region` overrides the identity's YouTube location for the legacy country recheck; the language stays the session language. */
export async function browserSession(fetcher: typeof fetch, identity: BrowserIdentity, region: string = IDENTITY_POLICY.country): Promise<Innertube> {
  try {
    return await Innertube.create({ fetch: fetcher, lang: IDENTITY_POLICY.language, location: region, timezone: IDENTITY_POLICY.timezone,
      user_agent: identity.user_agent, visitor_data: identity.visitor_data, retrieve_player: false, generate_session_locally: true,
      retrieve_innertube_config: false, enable_session_cache: false });
  } catch (error) { throw classify(error); }
}
export async function channelFacts(yt: Innertube, channelId: string, observedAt = new Date().toISOString(), locale: string = SESSION_LOCALE): Promise<ChannelFacts> {
  try {
    const channel = await yt.getChannel(channelId), aboutNode = await channel.getAbout() as unknown as Node;
    const about: Node = aboutNode.metadata ?? aboutNode;
    const meta = channel.metadata, now = observedAt;
    const header = strings(channel.header);
    // Legacy findSubscriberCountText: a labelled row, never a handle; an unlabelled row only when it is the one compact number.
    const subscribers = text(about.subscriber_count) ?? findSubscriberCountText(header, locale);
    const observed = (raw: unknown) => {
      const parsed = parseCount(text(raw), locale);
      return { value: parsed?.value ?? null, status: parsed ? parsed.exact ? 'exact' : 'estimated' : 'unresolved', source: 'youtubei:channel_about', observed_at: now };
    };
    const joined = absoluteDate(about.joined_date, locale);
    if (!meta.title) throw new ScrapeError('parse', 'Channel title missing');
    return ChannelFactsSchema.parse({ channel_id: channelId, channel_url: `https://www.youtube.com/channel/${channelId}`, title: meta.title,
      handle: meta.vanity_channel_url?.match(/@[^/]+/)?.[0] ?? header.find(s => /^@[\w.\-]+$/.test(s)) ?? null,
      avatar_url: thumb(meta.avatar ?? meta.thumbnail), summary: null, about_description: text(about.description) ?? meta.description ?? null,
      country: text(about.country), country_code: null, country_source: about.country ? 'youtubei:about' : null,
      joined_at: joined.value?.slice(0, 10) ?? null, joined_date_text: text(about.joined_date), joined_at_precision: joined.value ? 'date_only' : 'unknown',
      // The channel declaration says string[], but YouTube still returns a quoted keyword string.
      keywords: (Array.isArray(meta.keywords) ? meta.keywords : typeof meta.keywords === 'string' ? parseKeywords(meta.keywords) : meta.tags ?? []).slice(0, 100).map(s => s.slice(0, 200)), available_tabs: channel.tabs.slice(0, 20),
      external_links: (about.links ?? []).slice(0, 100).map((l: Node) => ({ title: (text(l.title) ?? '').slice(0, 500), url: /^https?:/.test(text(l.link) ?? '') ? text(l.link) : `https://${text(l.link)}` })).filter((l: Node) => l.url !== 'https://null'),
      subscriber_count: observed(subscribers), total_view_count: observed(about.view_count), total_video_count: observed(about.video_count),
      is_verified: null, is_family_safe: meta.is_family_safe ?? null, youtube_business_email_available: about.sign_in_for_business_email != null,
      observed_at: now, source: 'youtubei:channel_about' });
  } catch (error) { throw classify(error); }
}
/** Latest uploads, or incremental discovery until any of the 20 frozen anchors. Never skip private IDs. */
export async function uploads(yt: Innertube, channelId: string, limit: number, anchors?: string[]): Promise<UploadDiscovery & { exhausted: boolean }> {
  const ids: string[] = [], known = new Set(anchors ?? []); let scanned = 0, pages = 0;
  try {
    let page = await yt.getPlaylist(`UU${channelId.slice(2)}`);
    for (;;) {
      pages++;
      for (const video of page.videos) {
        // Uploads now include LockupView and ShortsLockupView, not just PlaylistVideo.
        const node = video as unknown as Node;
        const id = node.video_id ?? node.id ?? node.content_id ?? node.endpoint?.payload?.videoId
          ?? node.on_tap_endpoint?.payload?.videoId ?? node.on_tap_endpoint?.payload?.reelWatchEndpoint?.videoId
          ?? (typeof node.entity_id === 'string' ? node.entity_id.replace(/^shorts-shelf-item-/, '') : undefined);
        if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) throw new ScrapeError('parse', 'Upload identity missing');
        scanned++;
        if (known.has(id)) return { ids, pages, scanned, matched_anchor_id: id, stop_reason: 'anchor_matched', exhausted: false };
        if (!ids.includes(id)) ids.push(id);
        if (!anchors && ids.length >= limit) return { ids, pages, scanned, matched_anchor_id: null, stop_reason: 'list_end', exhausted: !page.has_continuation && scanned === page.videos.length };
        if (anchors && scanned >= 100) return { ids: ids.slice(0, 30), pages, scanned, matched_anchor_id: null, stop_reason: 'gap_abandoned_latest_30', exhausted: false };
      }
      if (!page.has_continuation) return { ids, pages, scanned, matched_anchor_id: null, stop_reason: 'list_end', exhausted: true };
      if (pages >= 20) throw new ScrapeError('parse', 'Upload pagination made insufficient progress');
      page = await page.getContinuation();
    }
  } catch (error) { throw classify(error); }
}
/** A player playability surface classified by the legacy rules (oldsystem youtubePlayability.js:71-128, same order and wording). */
export type Playability =
  | { kind: 'bot' }
  | { kind: 'content'; access: 'public' | 'members_only' | 'private' | 'unavailable'; availability: NonNullable<VideoFacts['availability']>; reason_code: string; alternate_region?: true }
  | { kind: 'inconclusive'; reason_code: string };
const fold = (value: unknown) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export function playability(value: Node | undefined): Playability {
  const status = String(value?.status ?? '').trim().toUpperCase(), reason = fold(value?.reason);
  if (/not a bot|nao (?:e|sou) (?:um )?(?:robo|bot)|no (?:eres|soy) (?:un )?robot|captcha|unusual traffic|verify you are human/.test(reason)) return { kind: 'bot' };
  if (/member|subscriber.only|premium|join this channel|membro|miembro/.test(reason)) return { kind: 'content', access: 'members_only', availability: 'subscriber_only', reason_code: 'members_only' };
  if (/private video|video is private|video privado|video particular/.test(reason)) return { kind: 'content', access: 'private', availability: 'private', reason_code: 'private' };
  if (/confirm your age|verify your age|age.restricted|confirme sua idade|verifica tu edad|confirma tu edad/.test(reason)) return { kind: 'content', access: 'public', availability: 'age_restricted', reason_code: 'age_restricted' };
  // Legacy wording plus the pt-BR player texts the pt-BR identity received before 10-13.
  if (/not (?:made )?(?:this )?video available in your country|not available in your country|country where you are located|region restricted|bloqueado en tu pais|nao esta disponivel (?:no|em) seu pais|nao (?:o )?disponibilizou no seu pais/.test(reason))
    return { kind: 'content', access: 'public', availability: 'region_restricted', reason_code: 'region_restricted', alternate_region: true };
  if (/removed by (?:the )?uploader|uploader has removed|removido pelo uploader|eliminado por quien lo subio/.test(reason)) return { kind: 'content', access: 'unavailable', availability: 'unavailable', reason_code: 'uploader_removed' };
  if (/copyright|direitos autorais|derechos de autor/.test(reason)) return { kind: 'content', access: 'unavailable', availability: 'unavailable', reason_code: 'copyright_removed' };
  if (/account (?:has been )?terminated|associated youtube account.*terminated|conta.*encerrad|cuenta.*cancelad/.test(reason)) return { kind: 'content', access: 'unavailable', availability: 'unavailable', reason_code: 'account_terminated' };
  if (/video (?:does not exist|not found)|video.*no existe|video.*nao existe/.test(reason)) return { kind: 'content', access: 'unavailable', availability: 'unavailable', reason_code: 'not_found' };
  if (/has been removed|video was removed|video foi removido|video ha sido eliminado/.test(reason)) return { kind: 'content', access: 'unavailable', availability: 'unavailable', reason_code: 'removed' };
  if (status === 'OK') return { kind: 'content', access: 'public', availability: 'public', reason_code: 'playable' };
  if (status === 'LOGIN_REQUIRED') return { kind: 'inconclusive', reason_code: 'unsupported_login_required_reason' };
  if (['UNPLAYABLE', 'ERROR'].includes(status)) return { kind: 'inconclusive', reason_code: !reason || /^video unavailable[.!]?$/.test(reason) ? 'generic_video_unavailable' : 'unsupported_playability_reason' };
  return { kind: 'inconclusive', reason_code: 'playability_unresolved' };
}
/** Legacy EXPLICIT_TERMINAL_REASON_CODES (youtubeJs.js:54): only these end the detail at once, on any client. */
const explicitTerminal = (p: Playability) => p.kind === 'content' && (p.reason_code === 'private' || p.reason_code === 'uploader_removed');
/** Legacy isPleaseSignInResponse (youtubeLoginRequired.js:2). */
const pleaseSignIn = (surface: Node | undefined) => String(surface?.status ?? '').trim().toUpperCase() === 'LOGIN_REQUIRED' && /^please\s+sign\s+in[.!]?$/i.test(String(surface?.reason ?? '').trim());
/**
 * Legacy access rule (youtubeJs.js:1546-1566): unlisted from the microformat; a content decision keeps its access
 * (age- and region-restricted stay public); an inconclusive or absent playability over a complete public surface
 * (publication and views, which mapWebVideo requires) is public.
 */
function access(info: Node): Pick<VideoFacts, 'access_status' | 'access_status_source' | 'is_members_only' | 'availability'> {
  const p = playability(info.playability_status), micro = info.page?.[0]?.microformat ?? {};
  if (micro.is_unlisted === true || info.basic_info?.is_unlisted === true) return { access_status: 'unlisted', access_status_source: 'youtubei:microformat', is_members_only: false, availability: 'unlisted' };
  if (p.kind === 'bot') return { access_status: 'unknown', access_status_source: 'youtubei:player', is_members_only: false };
  if (p.kind === 'content') return { access_status: p.access, access_status_source: 'youtubei:player', is_members_only: p.access === 'members_only', availability: p.availability };
  return { access_status: 'public', access_status_source: 'youtubei:public_metadata', is_members_only: false, availability: 'public' };
}
/** Legacy youtubeJsInfoNeedsAlternateClient (youtubeJs.js:1738-1764). */
function needsAlternateClient(info: Node, p: Playability, metricsOnly: boolean, locale: string): boolean {
  const basic = info.basic_info ?? {}, micro = info.page?.[0]?.microformat ?? {}, primary = info.primary_info ?? {};
  if (basic.is_upcoming === true) return false;
  if (p.kind === 'content' && p.access !== 'public') return false;
  const published = absoluteDate(micro.publish_date ?? micro.upload_date, locale).value ?? absoluteDate(primary.published?.text ?? primary.published, locale).value;
  const view = count(basic.view_count ?? micro.view_count ?? primary.view_count, locale);
  if (metricsOnly) {
    const status = String(info.playability_status?.status ?? '').toUpperCase();
    return p.kind === 'inconclusive' && status && status !== 'OK' ? !(published && view !== null) : view === null;
  }
  const title = text(basic.title ?? micro.title), duration = count(basic.duration ?? micro.length_seconds, locale);
  return !(title && published && view !== null && (duration || basic.is_live === true));
}
/** Legacy youtubeJsErrorNeedsTerminalProbe (youtubeJs.js:1767-1777): other request failures are not hidden behind IOS. */
function errorNeedsAlternateClient(error: unknown, surface: Node | undefined, p: Playability): boolean {
  if ((surface?.status || surface?.reason) && p.kind === 'inconclusive') return true;
  const message = String((error as Error)?.message ?? '').trim();
  return /^(?:this )?video is unavailable[.!]?$/i.test(message) || /login_required|please sign in|sign in to continue|not available on this app/i.test(message);
}
const canonicalKind = (value: unknown, videoId: string): 'short' | 'video' | null => {
  try {
    const url = new URL(String(value ?? ''), 'https://www.youtube.com'), shorts = /^\/shorts\/([^/?#]+)/i.exec(url.pathname);
    if (shorts && decodeURIComponent(shorts[1]!) === videoId) return 'short';
    return url.pathname === '/watch' && url.searchParams.get('v') === videoId ? 'video' : null;
  } catch { return null; }
};
/**
 * Legacy extractYoutubePlayerContentTypeSignals + resolveFromDetail (youtubeContentType.js:47-136): watch-page player
 * flags decide the type and nothing is guessed. A premiere is live only while it is upcoming; liveBroadcastDetails alone
 * is not a live signal.
 */
export function playerContentType(player: Node | undefined, videoId: string): { type: 'video' | 'short' | 'live'; source: string } | null {
  if (!player || typeof player !== 'object') return null;
  const details = player.videoDetails ?? {}, micro = player.microformat?.playerMicroformatRenderer ?? {};
  const flag = (...values: unknown[]) => values.find(v => typeof v === 'boolean') as boolean | undefined;
  const shorts = flag(micro.isShortsEligible, details.isShortsEligible), liveContent = flag(details.isLiveContent), isLive = flag(details.isLive),
    upcoming = flag(details.isUpcoming), liveNow = flag(micro.liveBroadcastDetails?.isLiveNow), canonical = canonicalKind(micro.canonicalUrl ?? player.canonicalUrl, videoId);
  if (liveContent === true) return { type: 'live', source: 'youtubei:player_live_content' };
  if (isLive === true || upcoming === true || liveNow === true) return { type: 'live', source: 'youtubei:player_live_flag' };
  if (shorts === true) return { type: 'short', source: 'youtubei:player_shorts_eligible' };
  if (canonical === 'short') return { type: 'short', source: 'youtubei:player_shorts_canonical' };
  if (canonical === 'video') return { type: 'video', source: 'youtubei:player_canonical' };
  if (shorts === false && (liveContent === false || isLive === false && upcoming === false && liveNow === false)) return { type: 'video', source: 'youtubei:player_type_flags' };
  return null;
}
export function mapWebVideo(info: Node, channelId: string, videoId: string, comments: CommentsResult, commentLimit: number, observedAt = new Date().toISOString(), locale: string = SESSION_LOCALE, metricsOnly = false): VideoFacts {
  const basic = info.basic_info ?? {}, micro = info.page?.[0]?.microformat ?? {}, primary = info.primary_info ?? {}, observed = observedAt;
  const publication = absoluteDate(micro.publish_date ?? micro.upload_date, locale);
  const published = publication.value ? publication : absoluteDate(primary.published?.text ?? primary.published, locale);
  const title = text(basic.title ?? micro.title ?? primary.title);
  const view = count(basic.view_count ?? micro.view_count ?? primary.view_count, locale);
  const duration = count(basic.duration ?? micro.length_seconds, locale);
  if (!title || !published.value || view === null || (!duration && basic.is_live !== true && basic.is_upcoming !== true)) throw new ScrapeError('parse', 'Video detail incomplete');
  // Uploads may list a collaboration or the artist's VEVO release; keep it with this channel and record its owner.
  const actualChannel = basic.channel_id ?? micro.channel?.id ?? info.secondary_info?.owner?.author?.id;
  // Use the existing comment mapping; replace API provenance with the actually observed web facts.
  // Legacy description order (youtubeJs.js:1594-1600): the player's short description, else the watch page description.
  const description = typeof basic.short_description === 'string' ? basic.short_description : text(info.secondary_info?.description) ?? undefined;
  const thumbnail = largestThumbnail(basic.thumbnail, micro.thumbnails);
  const facts = access(info), hint = count(info.comments_entry_point_header?.comment_count, locale);
  // Legacy youtubeJs.js:1499-1504: Message nodes of the watch page say when comments are turned off.
  const messages = Array.from((info.page?.[1]?.contents_memo?.getType?.(YTNodes.Message) ?? []) as Node[]).map(m => text(m.text));
  // Legacy isEmptyAgeGateCommentsResponse (youtubeJs.js:1425-1440): age-gated videos answer comments with nothing.
  const reason = text(info.playability_status?.reason) ?? '';
  const ageGate = comments.kind === 'page' && comments.surface === 'absent' && comments.comments.length === 0 && !comments.total_text
    && String(info.playability_status?.status ?? '').toUpperCase() === 'LOGIN_REQUIRED' && basic.is_family_safe === false && /confirm your age|age[- ]restricted|verify your age/i.test(reason);
  const mapped = toVideoFacts({ id: videoId, snippet: { channelId, title, description, publishedAt: published.value,
    tags: normalizeKeywords(basic.keywords, basic.tags, micro.keywords), thumbnails: thumbnail ? { default: { url: thumbnail } } : undefined },
    contentDetails: duration ? { duration: `PT${duration}S` } : {}, statistics: {} }, null, comments, commentLimit, observed,
    { hint: hint === null ? null : { value: hint, source: 'youtubei:next' }, disabledMessage: disabledCommentsText(messages), ageGate,
      upcoming: basic.is_upcoming === true, live: basic.is_live === true, accessible: ['public', 'unlisted'].includes(facts.access_status) });
  const metric = (value: number | null) => ({ value, status: value === null ? 'unresolved' as const : 'exact' as const, source: 'youtubei:video', observed_at: observed });
  // The first player with authoritative type evidence wins, so IOS without a microformat cannot erase WEB's (legacy V-90).
  const players: Node[] = info._raw_players ?? (info._raw_player ? [info._raw_player] : []);
  const type = players.map(p => playerContentType(p, videoId)).find(Boolean) ?? null;
  const live = type?.type === 'live', short = type?.type === 'short';
  const upcoming = basic.is_upcoming === true || players.some(p => p?.videoDetails?.isUpcoming === true);
  const start = basic.start_timestamp ?? micro.start_timestamp, end = basic.end_timestamp ?? micro.end_timestamp;
  const like = likeCount(info, locale);
  // Legacy missingLikeIsZero (detailPolicy.js:93-102): a full detail of an accessible video without a like count is a
  // policy zero. A metrics refresh reads no like button, so its missing count stays unresolved and keeps the stored one.
  const likeMetric = like.value !== null ? { value: like.value, status: like.status ?? 'exact' as const, source: like.source, observed_at: observed }
    : !metricsOnly && !['members_only', 'private', 'unavailable', 'login_required'].includes(facts.access_status) ? { value: 0, status: 'zero_from_empty' as const, source: 'public_empty_is_zero', observed_at: observed }
    : metric(null);
  const viewDetail = countDetail(basic.view_count ?? micro.view_count ?? primary.view_count, locale);
  return VideoFactsSchema.parse({ ...mapped, content_type: type?.type ?? 'video', content_type_source: type?.source ?? 'default:shorts_unknown',
    url: short && !live ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
    published_at: published.value, published_at_precision: published.precision, published_at_source: publication.value ? 'youtubei:player_microformat' : 'youtubei:next_date',
    published_text_raw: publication.value ? text(micro.publish_date ?? micro.upload_date) : text(primary.published?.text ?? primary.published),
    duration_seconds: metric(duration || null), view_count: viewDetail && !viewDetail.exact ? { ...metric(view), status: 'estimated' } : metric(view), like_count: likeMetric,
    ...facts, 
    // Legacy youtubeJs.js:1534-1535: a scheduled broadcast's start is its schedule, not a start.
    live_scheduled_at: upcoming && start ? new Date(start).toISOString() : null, live_started_at: !upcoming && start ? new Date(start).toISOString() : null,
    live_ended_at: end ? new Date(end).toISOString() : null,
    extractor_version: 'yt-collector/2 (youtubei.js 18.1.0 web)', ...(actualChannel && actualChannel !== channelId ? { owner_channel_id: actualChannel } : {}) });
}
/**
 * WEB, then IOS (legacy fetchYoutubeJsVideoInfoWithTerminalFallback, youtubeJs.js:1846-1897): a bot challenge fails the
 * identity; private or uploader-removed ends at once; a client whose public surface is incomplete hands over to the next;
 * members-only and removed content is accepted as it is. Both clients answering a plain "Please sign in" is the legacy
 * login exclusion. A region restriction without a usable surface is region_blocked at once: the block follows the exit
 * IP, so IOS through the same route would see it again (legacy asked IOS anyway); the collector rechecks it in the
 * channel's country instead (the legacy alternate_region retry mode, which legacy never carried out for videos).
 */
/**
 * `metricsRead` is how a metrics refresh reads the video: legacy reads player and next (youtubeJs.js:1857-1863), so likes
 * and the comment count hint are refreshed too; 'basic' replays units captured before 10-13, which hold only the player.
 */
export async function videoDetail(yt: Innertube, channelId: string, videoId: string, commentLimit: number, metricsOnly = false, responses: RawResponse[] = [], observedAt = new Date().toISOString(), locale: string = SESSION_LOCALE, metricsRead: 'info' | 'basic' = 'info'): Promise<VideoItem> {
  const surfaces: (Node | undefined)[] = [];
  for (const client of ['WEB', 'IOS'] as const) {
    let info: Node;
    try { info = metricsOnly && metricsRead === 'basic' ? await yt.getBasicInfo(videoId, { client }) : await yt.getInfo(videoId, { client }); }
    catch (error) {
      const surface = (error as Node).info?.playability_status ?? (error as Node).info?.playabilityStatus ?? (error as Node).info;
      const decision = playability(surface);
      if (decision.kind === 'bot') throw new ScrapeError('blocked', 'YouTube challenged this identity');
      if (explicitTerminal(decision)) return terminalVideo(channelId, videoId, decision.kind === 'content' && decision.reason_code === 'private' ? 'private' : 'removed', observedAt);
      if (decision.kind === 'content' && decision.alternate_region) return terminalVideo(channelId, videoId, 'region_blocked', observedAt);
      if (!errorNeedsAlternateClient(error, surface, decision)) throw classify(error);
      surfaces.push(surface);
      continue;
    }
    const decision = playability(info.playability_status);
    info._raw_players = responses.filter(r => r.endpoint.endsWith('/player')).flatMap(r => { try { return [JSON.parse(r.body)]; } catch { return []; } });
    if (decision.kind === 'bot') throw new ScrapeError('blocked', 'YouTube challenged this identity');
    if (explicitTerminal(decision)) return terminalVideo(channelId, videoId, decision.kind === 'content' && decision.reason_code === 'private' ? 'private' : 'removed', observedAt);
    if (needsAlternateClient(info, decision, metricsOnly, locale)) {
      if (decision.kind === 'content' && decision.alternate_region) return terminalVideo(channelId, videoId, 'region_blocked', observedAt);
      surfaces.push(info.playability_status); continue;
    }
    if (decision.kind === 'content' && decision.access === 'unavailable') return terminalVideo(channelId, videoId, 'removed', observedAt);
    // The fact contract needs title, publication, views and duration; a surface without them is handed to the next client.
    try { mapWebVideo(info, channelId, videoId, { kind: 'skipped' }, 0, observedAt, locale, metricsOnly); }
    catch {
      if (decision.kind === 'content' && decision.access === 'members_only') return terminalVideo(channelId, videoId, 'members_only', observedAt);
      surfaces.push(info.playability_status); continue;
    }
    const total = count(info.comments_entry_point_header?.comment_count, locale);
    const comments: CommentsResult = metricsOnly || !commentLimit ? { kind: 'skipped' } : await topComments(yt, videoId, total === null ? undefined : String(total), locale, observedAt).catch(() => ({ kind: 'unavailable' as const, collected_at: observedAt }));
    return mapWebVideo(info, channelId, videoId, comments, commentLimit, observedAt, locale, metricsOnly);
  }
  if (surfaces.length === 2 && surfaces.every(pleaseSignIn)) return terminalVideo(channelId, videoId, 'login_required', observedAt);
  throw new ScrapeError('parse', 'WEB and IOS video details exhausted');
}
function terminalVideo(channelId: string, videoId: string, status: 'private' | 'removed' | 'members_only' | 'login_required' | 'age_restricted' | 'region_blocked', observedAt: string): VideoItem {
  return VideoUnavailableSchema.parse({ channel_id: channelId, source_content_id: videoId, unavailable: true, access_status: status,
    reason: `YouTube player reports ${status}`, source: 'youtubei:player', observed_at: observedAt });
}
