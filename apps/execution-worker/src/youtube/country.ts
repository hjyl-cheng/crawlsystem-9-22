// Port of oldsystem qybullmq/src/agentCountryPolicy.js: an About country label, in any YouTube display language,
// resolves to one ISO 3166-1 alpha-2 code or to nothing; only a unique match counts.
import { YOUTUBE_UI_LANGUAGE_CODES } from './localized.ts';

const COUNTRY_ALIASES: Record<string, string> = {
  'bolivia (plurinational state of)': 'BO', 'brunei darussalam': 'BN', 'cabo verde': 'CV', 'czech republic': 'CZ',
  'democratic republic of the congo': 'CD', 'iran (islamic republic of)': 'IR', 'ivory coast': 'CI', "lao people's democratic republic": 'LA',
  'micronesia (federated states of)': 'FM', 'moldova (the republic of)': 'MD', 'republic of korea': 'KR', 'republic of the congo': 'CG',
  'russian federation': 'RU', 'south korea': 'KR', 'syrian arab republic': 'SY', 'taiwan, province of china': 'TW',
  'tanzania, united republic of': 'TZ', 'the netherlands': 'NL', 'turkiye': 'TR', 'türkiye': 'TR',
  'united kingdom of great britain and northern ireland': 'GB', 'united states of america': 'US',
  'venezuela (bolivarian republic of)': 'VE', 'viet nam': 'VN',
  // Not in legacy: short English names YouTube shows where the CLDR name is longer (stored data has "Hong Kong").
  'hong kong': 'HK', 'macau': 'MO', 'macao': 'MO', 'turkey': 'TR', 'palestine': 'PS',
};
const label = (value: string, fold = false) => {
  // Beyond legacy: "&" and "and", "St." and "Saint" are the same name ("Trinidad & Tobago", "St. Lucia").
  const out = value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ & /g, ' and ').replace(/(^|\s)st\.? /g, '$1saint ');
  return fold ? out.normalize('NFKD').replace(/\p{Mark}+/gu, '').normalize('NFC') : out;
};
interface Profile { codes: Set<string>; aliases: Map<string, string>; names: Map<string, string>; exact: Map<string, Set<string>>; folded: Map<string, Set<string>>; localized: boolean }
let cached: Profile | null = null;
const add = (index: Map<string, Set<string>>, key: string, code: string) => { if (key) index.set(key, (index.get(key) ?? new Set()).add(code)); };
function profile(): Profile {
  if (cached) return cached;
  const english = new Intl.DisplayNames(['en'], { type: 'region' }), p: Profile = { codes: new Set(), aliases: new Map(), names: new Map(), exact: new Map(), folded: new Map(), localized: false };
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b), name = english.of(code);
    if (!name || name === code) continue;
    let region = code;
    try { region = new Intl.Locale(`und-${code}`).region ?? code; } catch { /* keep the code */ }
    if (/^[A-Z]{2}$/.test(region) && region !== code) { p.aliases.set(code, region); continue; }
    p.codes.add(code); p.names.set(code, name);
    add(p.exact, label(name), code); add(p.folded, label(name, true), code);
  }
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) { add(p.exact, label(name), code); add(p.folded, label(name, true), code); }
  return cached = p;
}
const unique = (index: Map<string, Set<string>>, key: string) => { const m = index.get(key); return m?.size === 1 ? [...m][0]! : null; };
/** Legacy canonicalizeCrawlerCountry: code, retired-code alias, English name or alias, then every YouTube UI language. */
export function canonicalCountry(value: string | null | undefined): { raw: string | null; code: string | null; name: string | null } {
  const raw = String(value ?? '').trim();
  if (!raw) return { raw: null, code: null, name: null };
  const p = profile(), upper = raw.toUpperCase(), alias = p.aliases.get(upper);
  let code = p.codes.has(upper) ? upper : alias && p.codes.has(alias) ? alias : unique(p.exact, label(raw)) ?? unique(p.folded, label(raw, true));
  if (!code && !p.localized) {
    for (const locale of YOUTUBE_UI_LANGUAGE_CODES) {
      const names = new Intl.DisplayNames([locale], { type: 'region' });
      for (const c of p.codes) { const name = names.of(c); if (name && name !== c) { add(p.exact, label(name), c); add(p.folded, label(name, true), c); } }
    }
    p.localized = true;
  }
  code ??= unique(p.exact, label(raw)) ?? unique(p.folded, label(raw, true));
  return { raw, code, name: code ? p.names.get(code) ?? raw : null };
}
