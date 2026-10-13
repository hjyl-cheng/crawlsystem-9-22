// Port of oldsystem qybullmq/src/publicationUrl.js and publicationLinks.js: channel link targets, URL normalization,
// link type and purpose, shared by the collector (stored targets) and publication (delivered links).
const TRACKING = new Set(['_ga', '_gl', '_r', '_t', 'dclid', 'fbclid', 'gclid', 'igsh', 'igshid', 'mc_cid', 'mc_eid', 'msclkid', 'si', 'yclid']);
const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const rendered = typeof value === 'object' ? (() => { try { const s = String(value); return s === '[object Object]' ? '' : s; } catch { return ''; } })() : String(value);
  return rendered.trim() || null;
};
const nested = (value: unknown, path: (string | number)[]) => text(path.reduce<unknown>((node, key) => node == null ? null : (node as Record<string | number, unknown>)[key], value));
/** Legacy publicationLinkTarget: the tap command or endpoint URL of an About link, else its direct text. */
export function linkTarget(link: unknown): string | null {
  for (const path of [['link', 'command_runs', 0, 'on_tap', 'payload', 'url'], ['link', 'commandRuns', 0, 'onTap', 'payload', 'url'], ['link', 'command_runs', 0, 'on_tap', 'metadata', 'url'],
    ['link', 'commandRuns', 0, 'onTap', 'metadata', 'url'], ['link', 'endpoint', 'payload', 'url'], ['link', 'endpoint', 'metadata', 'url'], ['link', 'runs', 0, 'endpoint', 'payload', 'url'],
    ['link', 'runs', 0, 'endpoint', 'metadata', 'url'], ['endpoint', 'payload', 'url'], ['endpoint', 'metadata', 'url'], ['navigation_endpoint', 'payload', 'url'], ['navigation_endpoint', 'metadata', 'url'],
    ['navigationEndpoint', 'payload', 'url'], ['navigationEndpoint', 'metadata', 'url'], ['target_url'], ['url']] as (string | number)[][]) {
    const value = nested(link, path);
    if (value) return value;
  }
  const direct = (link as { link?: unknown } | null)?.link;
  return typeof direct === 'string' ? text(direct) : null;
}
/** Legacy normalizePublicationUrl: unwraps up to three YouTube redirects, drops tracking parameters, rejects credentials. */
export function normalizeUrl(raw: unknown, { contacts = false } = {}): string | null {
  let candidate = text(raw);
  if (!candidate) return null;
  const legacyMailto = /^mailto:(https?:\/\/.*)$/i.exec(candidate);
  if (legacyMailto) candidate = legacyMailto[1]!;
  for (let redirects = 0; redirects < 3; redirects++) {
    const bareEmail = !candidate.includes('/') && !/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate);
    if (contacts && (/^mailto:/i.test(candidate) || bareEmail)) {
      try { const address = decodeURIComponent(candidate.replace(/^mailto:/i, '').split(/[?#]/, 1)[0]!).trim().toLocaleLowerCase('en'); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? `mailto:${address}` : null; }
      catch { return null; }
    }
    if (contacts && /^tel:/i.test(candidate)) {
      const number = candidate.replace(/^tel:/i, '').split(/[?#]/, 1)[0]!.trim(), digits = number.replace(/\D/g, '');
      return digits.length < 8 || digits.length > 15 ? null : `tel:${number.startsWith('+') ? '+' : ''}${digits}`;
    }
    let parsed: URL;
    try { parsed = candidate.startsWith('//') ? new URL(`https:${candidate}`) : candidate.startsWith('/') ? new URL(candidate, 'https://www.youtube.com') : new URL(/^[a-z][a-z0-9+.-]*:/i.test(candidate) ? candidate : `https://${candidate}`); }
    catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    const redirect = /(^|\.)youtube\.com$/i.test(parsed.hostname) && parsed.pathname.replace(/\/+$/, '') === '/redirect' ? parsed.searchParams.get('q') ?? parsed.searchParams.get('url') : null;
    if (redirect) { candidate = redirect; continue; }
    parsed.hash = ''; parsed.hostname = parsed.hostname.toLocaleLowerCase('en');
    for (const key of [...parsed.searchParams.keys()]) if (key.toLocaleLowerCase('en').startsWith('utm_') || TRACKING.has(key.toLocaleLowerCase('en'))) parsed.searchParams.delete(key);
    if (parsed.protocol === 'https:' && parsed.port === '443' || parsed.protocol === 'http:' && parsed.port === '80') parsed.port = '';
    return parsed.toString();
  }
  return null;
}
const CONTACT_TYPES = new Set(['email', 'facebook', 'instagram', 'phone', 'telegram', 'tiktok', 'whatsapp', 'x_twitter']);
/** Legacy publicationLinkType. */
export function linkType(url: string): string | null {
  if (url.startsWith('mailto:')) return 'email';
  if (url.startsWith('tel:')) return 'phone';
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./i, '').toLocaleLowerCase('en'); } catch { return null; }
  const on = (...domains: string[]) => domains.some(d => host === d || host.endsWith(`.${d}`));
  return on('instagram.com') ? 'instagram' : on('facebook.com', 'fb.com') ? 'facebook' : on('x.com', 'twitter.com') ? 'x_twitter' : on('tiktok.com') ? 'tiktok'
    : on('spotify.com') ? 'spotify' : on('youtube.com', 'youtu.be') ? 'youtube' : on('whatsapp.com', 'wa.me') ? 'whatsapp' : on('t.me', 'telegram.me') ? 'telegram' : 'website';
}
/** Legacy publicationLinkPurpose: payment and shop links are public references; social and business wording is contact. */
export function linkPurpose(type: string | null, title: string | null, displayUrl: string | null = null): 'contact' | 'public_reference' {
  const context = `${title ?? ''} ${displayUrl ?? ''}`.toLocaleLowerCase('en');
  if (/(^|\W)(pix|paypal|donat|doa|coffee|apoie|shop|loja|compr)/i.test(context)) return 'public_reference';
  return type && CONTACT_TYPES.has(type) || /(contat|contact|business|commercial|comercial|inquir|e-?mail|parce|partner|collab|sponsor|suporte|support|atendimento)/i.test(context) ? 'contact' : 'public_reference';
}
