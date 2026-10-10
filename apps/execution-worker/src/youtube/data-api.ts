import type { ApiChannel, ApiVideo } from './map.ts';

// YouTube Data API v3 for exact listing and video facts (the player endpoint refuses
// datacenter clients). Keyed and quota-bound, so it goes direct, not through proxies.
// Quota: channels.list, playlistItems.list and videos.list cost 1 unit per call.
export class DataApiError extends Error {
  constructor(readonly kind: 'quota' | 'forbidden' | 'not_found' | 'invalid' | 'unavailable', readonly reason: string) { super(`Data API ${kind}: ${reason}`); this.name = 'DataApiError'; }
  get retryable() { return this.kind === 'unavailable'; }
}
/** Legacy discovery bounds: a first page and a catch-up of 50 items; without an anchor, keep the newest 30. */
const DISCOVERY_SCAN_LIMIT = 100, DISCOVERY_GAP_KEEP = 30;
export interface UploadDiscovery { ids: string[]; pages: number; scanned: number; matched_anchor_id: string | null; stop_reason: 'anchor_matched' | 'list_end' | 'gap_abandoned_latest_30' }
export type DataApiEndpoint = 'channels' | 'playlistItems' | 'videos';
/** Around each request: `permit` before sending (throws to refuse; may return the permit's id), `failed` when it fails. */
export interface RequestGuard {
  permit(endpoint: DataApiEndpoint): Promise<string | undefined>;
  failed?(requestId: string | undefined, endpoint: DataApiEndpoint, error: DataApiError): Promise<void>;
  response?(endpoint: DataApiEndpoint, status: number, body: string): void;
}
export class DataApi {
  units = 0;
  constructor(private key: string, private fetcher: typeof fetch = fetch, private base = 'https://www.googleapis.com/youtube/v3') {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) throw new Error('Invalid YouTube Data API key');
  }
  private async get<T>(path: DataApiEndpoint, params: Record<string, string>, guard?: RequestGuard): Promise<T> {
    const requestId = await guard?.permit(path);
    try { return await this.send<T>(path, params, guard); }
    catch (error) {
      if (error instanceof DataApiError) await guard?.failed?.(requestId, path, error).catch(() => undefined);
      throw error;
    }
  }
  private async send<T>(path: DataApiEndpoint, params: Record<string, string>, guard?: RequestGuard): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) url.searchParams.set(k, v);
    let response: Response;
    try { response = await this.fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } }); }
    catch { throw new DataApiError('unavailable', 'network'); }
    this.units++;
    const raw = await response.text(); guard?.response?.(path, response.status, raw);
    let body: { error?: { errors?: { reason?: string }[] } };
    try { body = JSON.parse(raw); } catch { throw new DataApiError('unavailable', 'invalid_json'); }
    if (response.ok) return body as T;
    // Never surface the URL (it carries the key) or the raw message.
    const reason = body.error?.errors?.[0]?.reason ?? `http_${response.status}`;
    if (/quota|rateLimit/i.test(reason)) throw new DataApiError('quota', reason);
    if (response.status === 404) throw new DataApiError('not_found', reason);
    if (response.status === 403) throw new DataApiError('forbidden', reason);
    if (response.status >= 500) throw new DataApiError('unavailable', reason);
    throw new DataApiError('invalid', reason);
  }
  async channel(id: string, guard?: RequestGuard): Promise<ApiChannel | null> {
    const body = await this.get<{ items?: ApiChannel[] }>('channels', { part: 'snippet,statistics,contentDetails,brandingSettings', id, maxResults: '1' }, guard);
    return body.items?.[0] ?? null;
  }
  /** Basic facts (title, country, counts) of up to 50 channels; channels that do not exist are absent. */
  async channelFacts(ids: string[], guard?: RequestGuard): Promise<ApiChannel[]> {
    if (!ids.length) return [];
    if (ids.length > 50) throw new Error('At most 50 channels per call');
    const body = await this.get<{ items?: ApiChannel[] }>('channels', { part: 'snippet,statistics', id: ids.join(','), maxResults: '50' }, guard);
    return body.items ?? [];
  }
  /** Newest uploads published at/after windowStart, at most `limit`, in upload-playlist order. */
  async recentUploads(uploadsPlaylist: string, windowStart: string, limit: number, guard?: RequestGuard): Promise<{ ids: string[]; exhausted: boolean }> {
    const ids: string[] = []; let page: string | undefined;
    for (let i = 0; i < 20; i++) {
      const body = await this.get<{ items?: { contentDetails: { videoId: string; videoPublishedAt?: string } }[]; nextPageToken?: string }>('playlistItems',
        { part: 'contentDetails', playlistId: uploadsPlaylist, maxResults: '50', ...(page ? { pageToken: page } : {}) }, guard);
      for (const item of body.items ?? []) {
        const published = item.contentDetails.videoPublishedAt;
        // Items without a publish time (e.g. private) are skipped; older items end the window.
        if (!published) continue;
        if (Date.parse(published) < Date.parse(windowStart)) return { ids, exhausted: true };
        ids.push(item.contentDetails.videoId);
        if (ids.length >= limit) return { ids, exhausted: false };
      }
      if (!body.nextPageToken) return { ids, exhausted: true };
      page = body.nextPageToken;
    }
    return { ids, exhausted: false };
  }
  /**
   * Incremental discovery (legacy incremental scan): uploads newest first until the first known anchor.
   * Up to a first page plus a catch-up of 50 items; past that without an anchor only the newest 30 are
   * kept (gap_abandoned_latest_30). Items without a publish time (private) are skipped.
   */
  async uploadsUntilAnchor(uploadsPlaylist: string, anchorIds: readonly string[], guard?: RequestGuard): Promise<UploadDiscovery> {
    const anchors = new Set(anchorIds), ids: string[] = [];
    let page: string | undefined, pages = 0;
    while (ids.length < DISCOVERY_SCAN_LIMIT) {
      const body = await this.get<{ items?: { contentDetails: { videoId: string; videoPublishedAt?: string } }[]; nextPageToken?: string }>('playlistItems',
        { part: 'contentDetails', playlistId: uploadsPlaylist, maxResults: '50', ...(page ? { pageToken: page } : {}) }, guard);
      pages += 1;
      for (const item of body.items ?? []) {
        const id = item.contentDetails.videoId;
        if (anchors.has(id)) return { ids, pages, scanned: ids.length, matched_anchor_id: id, stop_reason: 'anchor_matched' };
        if (!item.contentDetails.videoPublishedAt || ids.includes(id)) continue;
        ids.push(id);
        if (ids.length >= DISCOVERY_SCAN_LIMIT) break;
      }
      if (!body.nextPageToken) return { ids, pages, scanned: ids.length, matched_anchor_id: null, stop_reason: 'list_end' };
      page = body.nextPageToken;
    }
    return { ids: ids.slice(0, DISCOVERY_GAP_KEEP), pages, scanned: ids.length, matched_anchor_id: null, stop_reason: 'gap_abandoned_latest_30' };
  }
  async videos(ids: string[], guard?: RequestGuard): Promise<ApiVideo[]> {
    if (!ids.length) return [];
    if (ids.length > 50) throw new Error('At most 50 videos per call');
    const body = await this.get<{ items?: ApiVideo[] }>('videos', { part: 'snippet,contentDetails,statistics,status,liveStreamingDetails', id: ids.join(','), maxResults: '50' }, guard);
    return body.items ?? [];
  }
}
