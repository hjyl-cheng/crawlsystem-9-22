import type { ChannelFacts } from '@crawlsystem/contracts';
import type { RawResponse } from '../raw-archive.ts';
import type { ApiChannel } from './map.ts';
import { IDENTITY_POLICY } from './identity.ts';

/**
 * Legacy country policy: content that the default (BR) identity cannot see is collected
 * again with the channel's own country, both as egress IP and YouTube location. Without a
 * proxy for that country (legacy NO_COUNTRY_RESERVE) the default result stands.
 */
export const DEFAULT_REGION = IDENTITY_POLICY.country;
export class RegionUnavailable extends Error {
  constructor(readonly region: string) { super(`No ${region} proxy reserve`); this.name = 'RegionUnavailable'; }
}
export function regionCode(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
/** The responses of the last regional attempt in a unit, else none. */
export function regionalResponses(responses: RawResponse[]): RawResponse[] {
  const region = responses.slice().reverse().find(r => r.region)?.region;
  return region ? responses.filter(r => r.region === region) : [];
}
export const defaultResponses = (responses: RawResponse[]) => responses.filter(r => !r.region);
/** The channel record of the last successful Data API channels response, or null when absent or empty. */
export function capturedApiChannel(responses: RawResponse[], channelId: string): ApiChannel | null {
  const response = responses.slice().reverse().find(r => r.endpoint === 'https://www.googleapis.com/youtube/v3/channels' && r.status === 200);
  if (!response) return null;
  try { return (JSON.parse(response.body).items as ApiChannel[] | undefined)?.find(c => c.id === channelId) ?? null; } catch { return null; }
}
/** Web About facts collected in the channel's country keep the API's country code as provenance. */
export function regionalFacts(facts: ChannelFacts, api: ApiChannel | null): ChannelFacts {
  const code = regionCode(api?.snippet.country);
  return facts.country_code || !code ? facts : { ...facts, country_code: code, country_source: facts.country_source ?? 'data_api:snippet.country' };
}
