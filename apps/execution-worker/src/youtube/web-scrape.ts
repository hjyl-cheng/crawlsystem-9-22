import { Innertube } from 'youtubei.js';
import { ChannelFactsSchema, VideoFactsSchema, VideoUnavailableSchema, type ChannelFacts, type VideoFacts, type VideoItem } from '@crawlsystem/contracts';
import { ScrapeError, topComments, classify } from './scrape.ts';
import { parseCount, parseKeywords, toVideoFacts, type CommentsResult } from './map.ts';
import type { BrowserIdentity } from './identity.ts';
import { IDENTITY_POLICY } from './identity.ts';
import type { UploadDiscovery } from './data-api.ts';
import type { RawResponse } from '../raw-archive.ts';

// Parsed YouTube.js nodes change between versions. Keep their dynamic shapes inside this adapter.
type Node = Record<string, any>;
const text = (value: unknown): string | null => { const s = value?.toString(); return s && !['[object Object]', 'N/A'].includes(s) ? s : null; };
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : parseCount(text(value), 'pt-BR')?.value ?? null;
const thumb = (values: Node[] | undefined) => values?.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;
function strings(value: unknown, depth = 0): string[] {
  if (!value || depth > 9) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  const rendered = text(value);
  if (rendered && !rendered.includes('[object Object]') && !Array.isArray(value)) return [rendered];
  return Object.values(value).slice(0, 60).flatMap(v => strings(v, depth + 1));
}
export function absoluteDate(value: unknown): { value: string | null; precision: 'second' | 'date_only' | 'unknown' } {
  const raw = text(value) ?? '';
  const iso = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isFinite(iso)) return { value: new Date(iso).toISOString(), precision: raw.includes('T') ? 'second' : 'date_only' };
  const match = /(\d{1,2})\s+de\s+(jan(?:eiro)?|fev(?:ereiro)?|mar(?:ço)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\.?\s+de\s+(\d{4})/i.exec(raw);
  if (!match) return { value: null, precision: 'unknown' };
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const month = months.indexOf(match[2]!.slice(0, 3).toLowerCase()) + 1;
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? { value: parsed.toISOString(), precision: 'date_only' } : { value: null, precision: 'unknown' };
}
export async function browserSession(fetcher: typeof fetch, identity: BrowserIdentity): Promise<Innertube> {
  try {
    return await Innertube.create({ fetch: fetcher, lang: IDENTITY_POLICY.language, location: IDENTITY_POLICY.country, timezone: IDENTITY_POLICY.timezone,
      user_agent: identity.user_agent, visitor_data: identity.visitor_data, retrieve_player: false, generate_session_locally: true,
      retrieve_innertube_config: false, enable_session_cache: false });
  } catch (error) { throw classify(error); }
}
export async function channelFacts(yt: Innertube, channelId: string): Promise<ChannelFacts> {
  try {
    const channel = await yt.getChannel(channelId), aboutNode = await channel.getAbout() as unknown as Node;
    const about: Node = aboutNode.metadata ?? aboutNode;
    const meta = channel.metadata, now = new Date().toISOString();
    const header = strings(channel.header);
    const subscribers = text(about.subscriber_count) ?? header.find(s => /inscrit|subscri/i.test(s)) ?? null;
    const observed = (raw: unknown) => {
      const parsed = parseCount(text(raw), 'pt-BR');
      return { value: parsed?.value ?? null, status: parsed ? parsed.exact ? 'exact' : 'estimated' : 'unresolved', source: 'youtubei:channel_about', observed_at: now };
    };
    const joined = absoluteDate(about.joined_date);
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
export function playability(value: Node | undefined): { kind: 'ok' | 'blocked' | 'login' | 'terminal' | 'ambiguous'; status?: 'private' | 'removed' | 'members_only' | 'age_restricted' | 'region_blocked' } {
  const status = String(value?.status ?? ''), reason = String(value?.reason ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/not a bot|nao (?:e|sou) (?:um )?(?:robo|bot)|captcha|unusual traffic|verify you are human/.test(reason)) return { kind: 'blocked' };
  if (/private video|video is private|video privado|video particular/.test(reason)) return { kind: 'terminal', status: 'private' };
  if (/member|subscriber.only|join this channel|membro/.test(reason)) return { kind: 'terminal', status: 'members_only' };
  if (/removed|removido|copyright|direitos autorais|account.*terminated|conta.*encerrad|video.*not found/.test(reason)) return { kind: 'terminal', status: 'removed' };
  if (/confirm your age|age.restricted|confirme sua idade/.test(reason)) return { kind: 'terminal', status: 'age_restricted' };
  if (/not available in your country|nao esta disponivel no seu pais/.test(reason)) return { kind: 'terminal', status: 'region_blocked' };
  if (status === 'LOGIN_REQUIRED' && /^please\s+sign\s+in[.!]?$/.test(reason.trim())) return { kind: 'login' };
  return { kind: status === 'OK' ? 'ok' : 'ambiguous' };
}
export function mapWebVideo(info: Node, channelId: string, videoId: string, comments: CommentsResult, commentLimit: number): VideoFacts {
  const basic = info.basic_info ?? {}, micro = info.page?.[0]?.microformat ?? {}, primary = info.primary_info ?? {}, observed = new Date().toISOString();
  const publication = absoluteDate(micro.publish_date ?? micro.upload_date);
  const published = publication.value ? publication : absoluteDate(primary.published?.text ?? primary.published);
  const title = text(basic.title ?? micro.title ?? primary.title);
  const view = count(basic.view_count ?? micro.view_count ?? primary.view_count);
  const duration = count(basic.duration ?? micro.length_seconds);
  if (!title || !published.value || view === null || (!duration && basic.is_live !== true && basic.is_upcoming !== true)) throw new ScrapeError('parse', 'Video detail incomplete');
  const actualChannel = basic.channel_id ?? micro.channel?.id ?? info.secondary_info?.owner?.author?.id;
  if (actualChannel && actualChannel !== channelId) throw new ScrapeError('parse', 'Video belongs to another channel');
  // Use the existing comment mapping; replace API provenance with the actually observed web facts.
  const mapped = toVideoFacts({ id: videoId, snippet: { channelId, title, description: text(basic.short_description ?? info.secondary_info?.description) ?? '', publishedAt: published.value,
    tags: basic.keywords ?? [], thumbnails: { default: { url: thumb(basic.thumbnail ?? micro.thumbnails) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } } },
    contentDetails: duration ? { duration: `PT${duration}S` } : {}, statistics: {} }, null, comments, commentLimit, observed);
  const metric = (value: number | null) => ({ value, status: value === null ? 'unresolved' as const : 'exact' as const, source: 'youtubei:video', observed_at: observed });
  const player = info._raw_player ?? {}, rawMicro = player.microformat?.playerMicroformatRenderer ?? {};
  const live = basic.is_live === true || basic.is_live_content === true || basic.is_upcoming === true || !!rawMicro.liveBroadcastDetails;
  const canonical = text(rawMicro.canonicalUrl ?? micro.url_canonical) ?? '';
  const short = rawMicro.isShortsEligible === true || player.videoDetails?.isShortsEligible === true || basic.is_short === true || canonical.includes('/shorts/');
  const likeButtons = strings(primary.menu?.top_level_buttons);
  const like = count(basic.like_count) ?? count(likeButtons.find(s => /curtid|likes?/i.test(s) && /\d/.test(s)));
  const commentCount = comments.kind === 'page' ? parseCount(comments.total_text, 'pt-BR')?.value ?? null : count(info.comments_entry_point_header?.comment_count);
  return VideoFactsSchema.parse({ ...mapped, content_type: live ? 'live' : short ? 'short' : 'video', content_type_source: live || short || rawMicro.isShortsEligible === false ? 'youtubei:player' : 'default:shorts_unknown',
    url: short && !live ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
    published_at: published.value, published_at_precision: published.precision, published_at_source: publication.value ? 'youtubei:player_microformat' : 'youtubei:next_date',
    published_text_raw: publication.value ? text(micro.publish_date ?? micro.upload_date) : text(primary.published?.text ?? primary.published),
    duration_seconds: metric(duration || null), view_count: metric(view), like_count: metric(like),
    comment_count: comments.kind === 'disabled' ? { ...metric(0), status: 'disabled' } : { ...metric(commentCount), status: comments.kind === 'page' && commentCount !== null && !parseCount(comments.total_text, 'pt-BR')?.exact ? 'estimated' : commentCount === null ? 'unresolved' : 'exact' },
    access_status: micro.is_unlisted === true ? 'unlisted' : playability(info.playability_status).kind === 'ok' ? 'public' : 'unknown', access_status_source: 'youtubei:player',
    live_started_at: micro.start_timestamp ? new Date(micro.start_timestamp).toISOString() : null, live_ended_at: micro.end_timestamp ? new Date(micro.end_timestamp).toISOString() : null,
    extractor_version: 'yt-collector/2 (youtubei.js 18.1.0 web)' });
}
export async function videoDetail(yt: Innertube, channelId: string, videoId: string, commentLimit: number, metricsOnly = false, responses: RawResponse[] = []): Promise<VideoItem> {
  const logins: boolean[] = [];
  for (const client of ['WEB', 'IOS'] as const) {
    let info: Node;
    try { info = metricsOnly ? await yt.getBasicInfo(videoId, { client }) : await yt.getInfo(videoId, { client }); }
    catch (error) {
      const surface = (error as Node).info?.playability_status ?? (error as Node).info?.playabilityStatus ?? (error as Node).info;
      const decision = playability(surface);
      if (decision.kind === 'blocked') throw new ScrapeError('blocked', 'YouTube challenged this identity');
      if (decision.kind === 'terminal') return terminalVideo(channelId, videoId, decision.status!);
      logins.push(decision.kind === 'login');
      const classified = classify(error); if (classified.kind === 'network' || classified.kind === 'blocked') throw classified;
      continue;
    }
    const decision = playability(info.playability_status);
    const playerBody = responses.slice().reverse().find(r => r.endpoint.endsWith('/player'))?.body;
    if (playerBody) { try { info._raw_player = JSON.parse(playerBody); } catch { /* Parser owns malformed response handling. */ } }
    if (decision.kind === 'blocked') throw new ScrapeError('blocked', 'YouTube challenged this identity');
    if (decision.kind === 'terminal') return terminalVideo(channelId, videoId, decision.status!);
    logins.push(decision.kind === 'login');
    try { mapWebVideo(info, channelId, videoId, { kind: 'skipped' }, 0); }
    catch { continue; }
    // Plain sign-in responses are terminal only after both clients confirmed them.
    if (decision.kind === 'login') continue;
    const total = count(info.comments_entry_point_header?.comment_count);
    const comments: CommentsResult = metricsOnly || !commentLimit ? { kind: 'skipped' } : await topComments(yt, videoId, total === null ? undefined : String(total), 'pt-BR').catch(() => ({ kind: 'unavailable' as const, collected_at: new Date().toISOString() }));
    return mapWebVideo(info, channelId, videoId, comments, commentLimit);
  }
  if (logins.length === 2 && logins.every(Boolean)) return terminalVideo(channelId, videoId, 'login_required');
  throw new ScrapeError('parse', 'WEB and IOS video details exhausted');
}
function terminalVideo(channelId: string, videoId: string, status: 'private' | 'removed' | 'members_only' | 'login_required' | 'age_restricted' | 'region_blocked'): VideoItem {
  return VideoUnavailableSchema.parse({ channel_id: channelId, source_content_id: videoId, unavailable: true, access_status: status,
    reason: `YouTube player reports ${status}`, source: 'youtubei:player', observed_at: new Date().toISOString() });
}
