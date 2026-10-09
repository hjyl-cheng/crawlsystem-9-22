import { Innertube, Log } from 'youtubei.js';
import type { AboutPage, CommentsResult, ScrapedComment } from './map.ts';

// youtubei.js is confined to this file: parsed nodes are reduced to plain fields
// here, so parser changes in a new youtubei.js version surface in one place.
Log.setLevel(Log.Level.NONE);
export class ScrapeError extends Error {
  constructor(readonly kind: 'blocked' | 'network' | 'not_found' | 'parse', message: string) { super(message); this.name = 'ScrapeError'; }
}
const text = (value: unknown): string | null => { const s = (value as { toString?: () => string } | null | undefined)?.toString?.(); return s && s !== '[object Object]' && s !== 'N/A' ? s : null; };
function classify(error: unknown): ScrapeError {
  if (error instanceof ScrapeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { info?: { status?: number }; status?: number })?.info?.status ?? (error as { status?: number })?.status;
  if (status === 429 || /429|too many requests|unusual traffic|confirm you.re not a bot/i.test(message)) return new ScrapeError('blocked', 'YouTube rate limited or challenged this client');
  if (status === 404 || /not found|does not exist|this channel is not available/i.test(message)) return new ScrapeError('not_found', 'Channel or video not found');
  if (/fetch failed|ECONN|ETIMEDOUT|socket|proxy|timed out|network/i.test(message) || (error as { name?: string })?.name === 'ProxyConnectError') return new ScrapeError('network', 'Network or proxy failure');
  return new ScrapeError('parse', 'Unexpected YouTube response');
}
/** A client session; searches use the binding's language and country (YouTube hl/gl). */
export async function session(fetcher: typeof fetch, locale: { lang: string; location: string } = { lang: 'en', location: 'US' }): Promise<Innertube> {
  try { return await Innertube.create({ fetch: fetcher, retrieve_player: false, generate_session_locally: true, lang: locale.lang, location: locale.location }); }
  catch (error) { throw classify(error); }
}
const UPLOAD_DATE = { THIS_YEAR: 'year', THIS_WEEK: 'week', THIS_MONTH: 'month' } as const;
export interface SearchPage { items: { video_id: string; channel_id: string }[]; more: boolean }
/**
 * Video search result pages for a frozen query: upload window and popularity order (24.8 §5.2 keeps the
 * business window; this is the adapter's encoding). Each page is reduced to video and channel IDs; the
 * next page is fetched only when the caller asks for it.
 */
export async function* searchPages(yt: Innertube, text: string, window: keyof typeof UPLOAD_DATE): AsyncGenerator<SearchPage> {
  let search;
  try { search = await yt.search(text, { type: 'video', upload_date: UPLOAD_DATE[window], prioritize: 'popularity' }); }
  catch (error) { throw classify(error); }
  for (;;) {
    const items = search.videos.map(v => ({ video_id: (v as { video_id?: unknown }).video_id, channel_id: (v as { author?: { id?: unknown } }).author?.id }))
      .filter((i): i is SearchPage['items'][number] => typeof i.video_id === 'string' && /^[\w-]{11}$/.test(i.video_id) && typeof i.channel_id === 'string' && /^UC[\w-]{22}$/.test(i.channel_id));
    const more = search.has_continuation;
    yield { items, more };
    if (!more) return;
    try { search = await search.getContinuation(); }
    catch (error) { throw classify(error); }
  }
}
export async function aboutPage(yt: Innertube, channelId: string): Promise<AboutPage> {
  try {
    const channel = await yt.getChannel(channelId);
    const metadata = channel.metadata as { is_family_safe?: boolean };
    const about = (await channel.getAbout() as { metadata?: Record<string, unknown> }).metadata;
    if (!about) throw new ScrapeError('parse', 'About metadata missing');
    const links = (about.links as { title?: unknown; link?: unknown }[] | undefined ?? []).map(l => ({ title: text(l.title) ?? '', url: text(l.link) ?? '' })).filter(l => l.url);
    return { country: text(about.country), joined_text: text(about.joined_date), view_count_text: text(about.view_count), subscriber_text: text(about.subscriber_count),
      video_count_text: text(about.video_count), description: text(about.description), links,
      // The entry exists only when the channel has a business email (visible after sign-in).
      business_email: about.sign_in_for_business_email !== undefined && about.sign_in_for_business_email !== null,
      tabs: channel.tabs.map(t => String(t)).slice(0, 20), is_family_safe: typeof metadata.is_family_safe === 'boolean' ? metadata.is_family_safe : null, is_verified: null };
  } catch (error) { throw classify(error); }
}
/** Video IDs on the first page of the Shorts tab; an empty set when the channel has no Shorts tab. */
export async function shortsIds(yt: Innertube, channelId: string): Promise<Set<string>> {
  try {
    const channel = await yt.getChannel(channelId);
    if (!channel.has_shorts) return new Set();
    const shorts = await channel.getShorts() as unknown as { videos?: { on_tap_endpoint?: { payload?: { videoId?: string } }; content_id?: string; id?: string }[] };
    return new Set((shorts.videos ?? []).map(v => v.on_tap_endpoint?.payload?.videoId ?? v.content_id ?? v.id).filter((id): id is string => typeof id === 'string'));
  } catch (error) { throw classify(error); }
}
/** First page of Top comments. `disabledLikely` (no comment count from the API) turns a refusal into "disabled". */
export async function topComments(yt: Innertube, videoId: string, disabledLikely: boolean): Promise<CommentsResult> {
  const collected_at = new Date().toISOString();
  try {
    const page = await yt.getComments(videoId, 'TOP_COMMENTS') as unknown as { header?: { comments_count?: unknown }; contents?: { comment?: Record<string, unknown> }[] };
    const comments: ScrapedComment[] = (page.contents ?? []).map(t => t.comment).filter((c): c is Record<string, unknown> => !!c && typeof c.comment_id === 'string').map(c => {
      const author = (c.author ?? {}) as { name?: string; id?: string; url?: string; is_verified?: boolean; best_thumbnail?: { url?: string } };
      return { comment_id: c.comment_id as string, text: text(c.content) ?? '', author_name: author.name ?? null, author_channel_id: author.id && /^UC[\w-]{22}$/.test(author.id) ? author.id : null,
        author_url: author.url ?? null, author_avatar_url: author.best_thumbnail?.url ?? (typeof c.creator_thumbnail_url === 'string' ? c.creator_thumbnail_url : null),
        published_text: text(c.published_time), like_text: text(c.like_count), reply_text: text(c.reply_count),
        is_pinned: typeof c.is_pinned === 'boolean' ? c.is_pinned : null, is_channel_owner: typeof c.author_is_channel_owner === 'boolean' ? c.author_is_channel_owner : null,
        is_verified: typeof author.is_verified === 'boolean' ? author.is_verified : null, is_hearted: typeof c.is_hearted === 'boolean' ? c.is_hearted : null };
    });
    return { kind: 'page', total_text: text(page.header?.comments_count), comments, collected_at };
  } catch (error) {
    const classified = classify(error);
    if (disabledLikely && classified.kind === 'parse') return { kind: 'disabled', collected_at };
    throw classified;
  }
}
