import type { ApiChannel, ApiVideo } from './map.ts';

// YouTube Data API v3 for exact listing and video facts (the player endpoint refuses
// datacenter clients). Keyed and quota-bound, so it goes direct, not through proxies.
// Quota: channels.list, playlistItems.list and videos.list cost 1 unit per call.
export class DataApiError extends Error {
  constructor(readonly kind: 'quota' | 'forbidden' | 'not_found' | 'invalid' | 'unavailable', readonly reason: string) { super(`Data API ${kind}: ${reason}`); this.name = 'DataApiError'; }
  get retryable() { return this.kind === 'unavailable'; }
}
export class DataApi {
  units = 0;
  constructor(private key: string, private fetcher: typeof fetch = fetch, private base = 'https://www.googleapis.com/youtube/v3') {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) throw new Error('Invalid YouTube Data API key');
  }
  private async get<T>(path: string, params: Record<string, string>, beforeRequest?: () => Promise<void>): Promise<T> {
    await beforeRequest?.();
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) url.searchParams.set(k, v);
    let response: Response;
    try { response = await this.fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } }); }
    catch { throw new DataApiError('unavailable', 'network'); }
    this.units++;
    const body = await response.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[] } };
    if (response.ok) return body as T;
    // Never surface the URL (it carries the key) or the raw message.
    const reason = body.error?.errors?.[0]?.reason ?? `http_${response.status}`;
    if (/quota|rateLimit/i.test(reason)) throw new DataApiError('quota', reason);
    if (response.status === 404) throw new DataApiError('not_found', reason);
    if (response.status === 403) throw new DataApiError('forbidden', reason);
    if (response.status >= 500) throw new DataApiError('unavailable', reason);
    throw new DataApiError('invalid', reason);
  }
  async channel(id: string, beforeRequest?: () => Promise<void>): Promise<ApiChannel | null> {
    const body = await this.get<{ items?: ApiChannel[] }>('channels', { part: 'snippet,statistics,contentDetails,brandingSettings', id, maxResults: '1' }, beforeRequest);
    return body.items?.[0] ?? null;
  }
  /** Newest uploads published at/after windowStart, at most `limit`, in upload-playlist order. */
  async recentUploads(uploadsPlaylist: string, windowStart: string, limit: number, beforeRequest?: () => Promise<void>): Promise<{ ids: string[]; exhausted: boolean }> {
    const ids: string[] = []; let page: string | undefined;
    for (let i = 0; i < 20; i++) {
      const body = await this.get<{ items?: { contentDetails: { videoId: string; videoPublishedAt?: string } }[]; nextPageToken?: string }>('playlistItems',
        { part: 'contentDetails', playlistId: uploadsPlaylist, maxResults: '50', ...(page ? { pageToken: page } : {}) }, beforeRequest);
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
  async videos(ids: string[], beforeRequest?: () => Promise<void>): Promise<ApiVideo[]> {
    if (!ids.length) return [];
    if (ids.length > 50) throw new Error('At most 50 videos per call');
    const body = await this.get<{ items?: ApiVideo[] }>('videos', { part: 'snippet,contentDetails,statistics,status,liveStreamingDetails', id: ids.join(','), maxResults: '50' }, beforeRequest);
    return body.items ?? [];
  }
}
