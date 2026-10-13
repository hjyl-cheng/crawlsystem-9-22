// Localized count and time parsing, ported from the legacy collector:
// oldsystem/services/qybullmq/src/localizedCount.js, localizedTime.js, localizedParsing.js and youtubeLanguages.js.
// Rules are generated from ICU (Intl) data per locale instead of hand-written per language, so the same
// functions read "1.2K subscribers" (en), "1,2 mil inscritos" (pt-BR) or "3 days ago" / "há 3 dias".

/** YouTube's current WEB display-language codes (legacy youtubeLanguages.js). */
export const YOUTUBE_UI_LANGUAGE_CODES = Object.freeze([
  'af', 'az', 'id', 'ms', 'bs', 'ca', 'cs', 'da', 'de', 'et',
  'en-IN', 'en-GB', 'en', 'es', 'es-419', 'es-US', 'eu', 'fil', 'fr', 'fr-CA',
  'gl', 'hr', 'zu', 'is', 'it', 'sw', 'lv', 'lt', 'hu', 'nl',
  'no', 'uz', 'pl', 'pt-PT', 'pt', 'ro', 'sq', 'sk', 'sl', 'sr-Latn',
  'fi', 'sv', 'vi', 'tr', 'be', 'bg', 'ky', 'kk', 'mk', 'mn',
  'ru', 'sr', 'uk', 'el', 'hy', 'iw', 'ur', 'ar', 'fa', 'ne',
  'mr', 'hi', 'as', 'bn', 'pa', 'gu', 'or', 'ta', 'te', 'kn',
  'ml', 'si', 'th', 'lo', 'my', 'ka', 'am', 'km', 'zh-CN', 'zh-TW',
  'zh-HK', 'ja', 'ko',
]);

/** A present value in a format the parser does not support: fail loudly instead of storing a wrong or missing value. */
export class LocalizedParseError extends Error {
  readonly code = 'PARSER_CONTRACT_ERROR';
  constructor(readonly field: string, readonly rawValue: string, readonly locale: string | null, readonly source: string | null, readonly reason = 'unsupported_localized_format') {
    super(`[PARSER_CONTRACT_ERROR] ${JSON.stringify({ field, locale, source, reason, raw_value: rawValue.slice(0, 1000) })}`);
    this.name = 'LocalizedParseError';
  }
}

function canonicalLocale(value: string | undefined, fallback = 'en'): string {
  try { return Intl.getCanonicalLocales(String(value || fallback).replaceAll('_', '-'))[0] || fallback; } catch { return 'en'; }
}

// ---- Counts (localizedCount.js) ----

// Unicode decimal digit blocks. NFKC handles compatibility digits; these cover native decimal systems Number() does not parse.
const DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0,
  0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900,
  0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
  0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2,
  0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
];
const COMMON_COMPACT_UNITS: [string, number][] = [
  ['thousand', 1e3], ['thousands', 1e3], ['mil', 1e3], ['mille', 1e3], ['mila', 1e3], ['тыс', 1e3], ['тис', 1e3],
  ['हजार', 1e3], ['हज़ार', 1e3], ['ألف', 1e3], ['الف', 1e3], ['هزار', 1e3], ['천', 1e3], ['千', 1e3], ['rb', 1e3],
  ['million', 1e6], ['millions', 1e6], ['milhao', 1e6], ['milhoes', 1e6], ['milhão', 1e6], ['milhões', 1e6], ['mio', 1e6], ['mln', 1e6],
  ['млн', 1e6], ['مليون', 1e6], ['میلیون', 1e6], ['ล้าน', 1e6], ['jt', 1e6], ['trieu', 1e6], ['triệu', 1e6],
  ['billion', 1e9], ['billions', 1e9], ['bilhao', 1e9], ['bilhoes', 1e9], ['bilhão', 1e9], ['bilhões', 1e9],
  ['mrd', 1e9], ['млрд', 1e9], ['مليار', 1e9], ['میلیارد', 1e9],
  ['lakh', 1e5], ['lakhs', 1e5], ['लाख', 1e5], ['লাখ', 1e5], ['لاکھ', 1e5],
  ['crore', 1e7], ['crores', 1e7], ['करोड़', 1e7], ['करोड', 1e7], ['কোটি', 1e7], ['کروڑ', 1e7],
  ['万', 1e4], ['萬', 1e4], ['만', 1e4], ['亿', 1e8], ['億', 1e8], ['억', 1e8],
  ['k', 1e3], ['m', 1e6], ['b', 1e9], ['mi', 1e6], ['bi', 1e9],
];
const SUBSCRIBER_LABEL = new RegExp(['subscriber', 'subscritor', 'suscriptor', 'inscrit', 'abonn', 'iscritt', 'abonnee', 'abone', 'subskryb', 'odberat',
  'tilaaj', 'prenumerant', 'feliratkoz', 'abonat', 'подпис', 'підпис', '구독', '登録者', '订阅', '訂閱', 'مشترك', 'مشترک', 'सब्सक्राइबर', 'सदस्य',
  'সাবস্ক্রাইবার', 'গ্রাহক', 'سبسکرائبر', 'ผู้ติดตาม', 'người đăng ký', 'pelanggan', 'מנוי', 'מנויים', 'συνδρομητ', 'tagasubaybay', 'wanaofuatilia'].join('|'), 'iu');

interface CountProfile { locale: string; decimal: string; digits: Map<string, string>; units: [string, number][] }
const countProfiles = new Map<string, CountProfile>();
function nativeDigit(char: string): number | null {
  const point = char.codePointAt(0)!;
  for (const zero of DECIMAL_ZERO_CODE_POINTS) { const value = point - zero; if (value >= 0 && value <= 9) return value; }
  return null;
}
function normalizeDigits(value: string, digits = new Map<string, string>()): string {
  let out = '';
  for (const char of String(value ?? '').normalize('NFKC')) {
    if (digits.has(char)) { out += digits.get(char); continue; }
    const n = nativeDigit(char); out += n === null ? char : String(n);
  }
  return out;
}
const unitText = (value: string) => String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function addUnit(units: Map<string, number>, token: string, multiplier: number, overwrite = false) {
  const normalized = unitText(token);
  if (!normalized) return;
  for (const variant of new Set([normalized, normalized.replace(/[.。]+$/u, '')])) if (variant && (overwrite || !units.has(variant))) units.set(variant, multiplier);
}
function compactCoefficient(parts: Intl.NumberFormatPart[], digits: Map<string, string>): number | null {
  const integer = normalizeDigits(parts.filter(p => p.type === 'integer').map(p => p.value).join(''), digits);
  const fraction = normalizeDigits(parts.filter(p => p.type === 'fraction').map(p => p.value).join(''), digits);
  const value = Number(fraction ? `${integer}.${fraction}` : integer);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function countProfile(localeValue: string): CountProfile {
  const locale = canonicalLocale(localeValue);
  const cached = countProfiles.get(locale); if (cached) return cached;
  const digits = new Map(Array.from({ length: 10 }, (_, v) => [String(v), String(v)] as [string, string]));
  const plain = new Intl.NumberFormat(locale, { useGrouping: false });
  for (let v = 0; v <= 9; v++) for (const char of plain.format(v)) if (/\p{Decimal_Number}/u.test(char)) digits.set(char, String(v));
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(p => p.type === 'decimal')?.value ?? '.';
  const units = new Map<string, number>(), localeTokens = new Set<string>();
  for (const [token, multiplier] of COMMON_COMPACT_UNITS) addUnit(units, token, multiplier);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 2 });
  for (const magnitude of [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12]) {
    const parts = compact.formatToParts(magnitude);
    const token = parts.filter(p => p.type === 'compact').map(p => p.value).join(''), coefficient = compactCoefficient(parts, digits);
    if (!token || !coefficient) continue;
    const normalized = unitText(token).replace(/[.。]+$/u, '');
    // A locale's own compact symbol wins over the common table (Turkish "B" is a thousand, not a billion).
    addUnit(units, token, Math.round(magnitude / coefficient), !localeTokens.has(normalized));
    localeTokens.add(normalized);
  }
  const profile = { locale, decimal, digits, units: [...units.entries()].sort((a, b) => b[0].length - a[0].length) };
  countProfiles.set(locale, profile); return profile;
}
function unitAfter(suffix: string, profile: CountProfile) {
  const text = unitText(suffix).replace(/^[\s:：;；,，.。~≈≃\-–—]+/u, '');
  for (const [token, multiplier] of profile.units) {
    if (!text.startsWith(token)) continue;
    const next = text.slice(token.length, token.length + 1);
    if (/^[a-z]+$/i.test(token) && next && /[\p{Letter}\p{Mark}]/u.test(next)) continue;
    return { token, multiplier };
  }
  return { token: null, multiplier: 1 };
}
function unitBefore(prefix: string, profile: CountProfile) {
  const text = unitText(prefix).replace(/[\s:：;；,，.。~≈≃\-–—]+$/u, '');
  for (const [token, multiplier] of profile.units) {
    if (!text.endsWith(token)) continue;
    const previous = text.slice(Math.max(0, text.length - token.length - 1), -token.length);
    if (/^[a-z]+$/i.test(token) && previous && /[\p{Letter}\p{Mark}]/u.test(previous)) continue;
    return { token, multiplier };
  }
  return { token: null, multiplier: 1 };
}
function numberToken(token: string, profile: CountProfile, compact: boolean): number | null {
  const normalized = normalizeDigits(token, profile.digits);
  if (!compact) { const digits = normalized.replace(/\D/g, ''); return digits ? Number(digits) : null; }
  // Abbreviated counts carry a decimal part; unabbreviated separators are grouping.
  let index = -1, symbol: string | null = null;
  for (const candidate of new Set([profile.decimal, '.', ',', '٫'])) { const at = normalized.lastIndexOf(candidate); if (at > index) { index = at; symbol = candidate; } }
  let out = '';
  for (let i = 0; i < normalized.length; i++) { const char = normalized[i]!; if (/\d/.test(char)) out += char; else if (symbol && char === symbol && i === index) out += '.'; }
  const value = Number(out); return Number.isFinite(value) ? value : null;
}
export interface CountDetails { value: number; multiplier: number; unit: string | null; locale: string }
/** The count in a localized display text; `multiplier > 1` means an abbreviated (estimated) value. */
export function parseLocalizedCountDetails(value: unknown, locale: string): CountDetails | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { value: Math.round(value), multiplier: 1, unit: null, locale: canonicalLocale(locale) };
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).normalize('NFKC');
  const match = raw.match(/[\p{Decimal_Number}]+(?:[\s  .,，．٫٬'’_]*[\p{Decimal_Number}]+)*/u);
  if (!match) return null;
  const profile = countProfile(locale), start = match.index ?? 0;
  const after = unitAfter(raw.slice(start + match[0].length), profile);
  const unit = after.multiplier > 1 ? after : unitBefore(raw.slice(0, start), profile);
  const number = numberToken(match[0], profile, unit.multiplier > 1);
  if (number === null || !Number.isFinite(number)) return null;
  const count = Math.round(number * unit.multiplier);
  return Number.isSafeInteger(count) && count >= 0 ? { value: count, multiplier: unit.multiplier, unit: unit.token, locale: profile.locale } : null;
}
export const parseLocalizedCount = (value: unknown, locale: string) => parseLocalizedCountDetails(value, locale)?.value ?? null;
export function parseRequiredLocalizedCount(value: unknown, locale: string, field = 'localized_count', source: string | null = null): number {
  const details = parseLocalizedCountDetails(value, locale);
  if (details) return details.value;
  throw new LocalizedParseError(field, String(value ?? ''), canonicalLocale(locale), source, 'unsupported_localized_count');
}
export const looksLikeSubscriberCountText = (value: unknown) => SUBSCRIBER_LABEL.test(String(value ?? '').normalize('NFKC'));
/** The subscriber text among header rows; a handle never counts, an unlabelled row only when it is the one compact number. */
export function findSubscriberCountText(values: unknown[], locale: string): string | null {
  const texts = values.map(v => String(v ?? '').trim()).filter(v => v && !v.startsWith('@') && !/(?:^|\/)youtube\.com\/@/i.test(v));
  const labelled = texts.find(looksLikeSubscriberCountText);
  if (labelled) return labelled;
  const compact = texts.filter(t => (parseLocalizedCountDetails(t, locale)?.multiplier ?? 1) > 1);
  return compact.length === 1 ? compact[0]! : null;
}

// ---- Times (localizedTime.js) ----

const DAY_MS = 86_400_000;
const NUMBER_TYPES = new Set(['integer', 'group', 'decimal', 'fraction']);
const NUMBER_PATTERN = "([\\p{Decimal_Number}](?:[\\p{Decimal_Number}\\s\\u00a0\\u202f.,，．٫٬'’_]*?[\\p{Decimal_Number}])?)";
const DATE_PART = '[\\p{Decimal_Number}]';
type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
const UNIT_DAYS: Record<Unit, number> = { second: 0, minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 };
const UNIT_MS: Record<Unit, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS };
const timeText = (value: unknown, locale: string) => String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
  .replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase(locale);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literal = (value: string, locale: string) => { const n = timeText(value, locale); return n ? n.split(' ').map(escape).join('\\s*') : ''; };
function containsPhrase(value: string, phrase: string): boolean {
  for (let at = value.indexOf(phrase); at >= 0; at = value.indexOf(phrase, at + 1)) {
    const before = at === 0 ? '' : value[at - 1]!, after = value[at + phrase.length] ?? '';
    if ((!/^[a-z0-9]/i.test(phrase) || !/[a-z0-9]/i.test(before)) && (!/[a-z0-9]$/i.test(phrase) || !/[a-z0-9]/i.test(after))) return true;
  }
  return false;
}
interface RelativeProfile { locale: string; patterns: { regex: RegExp; unit: Unit }[]; exact: { phrase: string; amount: number; unit: Unit }[] }
const relativeProfiles = new Map<string, RelativeProfile>();
function relativeProfile(localeValue: string): RelativeProfile {
  const locale = canonicalLocale(localeValue);
  const cached = relativeProfiles.get(locale); if (cached) return cached;
  const patterns: RelativeProfile['patterns'] = [], exact: RelativeProfile['exact'] = [], seenPatterns = new Set<string>(), seenExact = new Set<string>();
  for (const unit of Object.keys(UNIT_DAYS) as Unit[]) for (const style of ['long', 'short', 'narrow'] as const) {
    const always = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style });
    for (const amount of [1, 2, 3, 4, 5, 10, 11, 20, 21, 100]) {
      const parts = always.formatToParts(-amount, unit);
      const first = parts.findIndex(p => NUMBER_TYPES.has(p.type));
      let last = -1; for (let i = parts.length - 1; i >= 0; i--) if (NUMBER_TYPES.has(parts[i]!.type)) { last = i; break; }
      if (first < 0) {
        const phrase = timeText(parts.map(p => p.value).join(''), locale), key = `${phrase}:${amount * UNIT_DAYS[unit]}`;
        if (phrase && !seenExact.has(key)) { seenExact.add(key); exact.push({ phrase, amount, unit }); }
        continue;
      }
      const source = `${literal(parts.slice(0, first).map(p => p.value).join(''), locale)}\\s*${NUMBER_PATTERN}\\s*${literal(parts.slice(last + 1).map(p => p.value).join(''), locale)}`;
      const key = `${source}:${UNIT_DAYS[unit]}`;
      if (seenPatterns.has(key)) continue;
      seenPatterns.add(key); patterns.push({ regex: new RegExp(source, 'u'), unit });
    }
    const automatic = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
    for (const amount of [0, 1, 2]) {
      const phrase = timeText(automatic.format(-amount, unit), locale), key = `${phrase}:${amount * UNIT_DAYS[unit]}`;
      if (!phrase || /\p{Decimal_Number}/u.test(phrase) || seenExact.has(key)) continue;
      seenExact.add(key); exact.push({ phrase, amount, unit });
    }
  }
  patterns.sort((a, b) => b.regex.source.length - a.regex.source.length);
  exact.sort((a, b) => b.phrase.length - a.phrase.length);
  const profile = { locale, patterns, exact }; relativeProfiles.set(locale, profile); return profile;
}
function utcDay(year: number | null | undefined, month: number | null | undefined, day: number | null | undefined): string | null {
  if (!Number.isSafeInteger(year) || year! < 1900 || year! > 3000 || !Number.isSafeInteger(month) || month! < 1 || month! > 12 || !Number.isSafeInteger(day) || day! < 1 || day! > 31) return null;
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day ? parsed.toISOString().slice(0, 10) : null;
}
interface DateProfile { locale: string; patterns: { regex: RegExp; months: Map<string, number> }[] }
const dateProfiles = new Map<string, DateProfile>();
function dateProfile(localeValue: string): DateProfile {
  const locale = canonicalLocale(localeValue);
  const cached = dateProfiles.get(locale); if (cached) return cached;
  const patterns: DateProfile['patterns'] = [], seen = new Set<string>();
  for (const monthStyle of ['long', 'short', 'numeric', '2-digit'] as const) {
    const formatter = new Intl.DateTimeFormat(locale, { calendar: 'gregory', timeZone: 'UTC', year: 'numeric', month: monthStyle, day: 'numeric' });
    const months = new Map<string, number>();
    if (monthStyle === 'long' || monthStyle === 'short') for (let month = 1; month <= 12; month++) {
      const token = timeText(formatter.formatToParts(new Date(Date.UTC(2006, month - 1, 22))).find(p => p.type === 'month')?.value, locale);
      if (token) months.set(token, month);
    }
    const parts = formatter.formatToParts(new Date(Date.UTC(2006, 10, 22)));
    if (!['year', 'month', 'day'].every(type => parts.some(p => p.type === type))) continue;
    const source = parts.map(p => p.type === 'year' ? `(?<year>${DATE_PART}{4})` : p.type === 'day' ? `(?<day>${DATE_PART}{1,2})`
      : p.type !== 'month' ? `\\s*${literal(p.value, locale)}\\s*`
      : months.size === 0 ? `(?<month>${DATE_PART}{1,2})` : `(?<month>${[...months.keys()].sort((a, b) => b.length - a.length).map(t => literal(t, locale)).join('|')})`).join('');
    if (!source || seen.has(source)) continue;
    seen.add(source); patterns.push({ regex: new RegExp(source, 'u'), months });
  }
  const profile = { locale, patterns }; dateProfiles.set(locale, profile); return profile;
}
/** "Aug 18, 2026", "18 de ago. de 2026" or an ISO date → the UTC calendar day, else null. */
export function localizedAbsoluteUtcDay(value: unknown, locale: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (iso) return utcDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const profile = dateProfile(locale), normalized = timeText(raw, profile.locale);
  for (const pattern of profile.patterns) {
    const groups = pattern.regex.exec(normalized)?.groups;
    if (!groups) continue;
    const month = pattern.months.size === 0 ? parseLocalizedCount(groups.month, profile.locale) : pattern.months.get(timeText(groups.month, profile.locale));
    const day = utcDay(parseLocalizedCount(groups.year, profile.locale), month, parseLocalizedCount(groups.day, profile.locale));
    if (day) return day;
  }
  return null;
}
/** "3 days ago", "há 3 dias", "Streamed yesterday" → amount and unit, else null. */
export function parseLocalizedRelativeAge(value: unknown, locale: string): { amount: number; unit: Unit } | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const profile = relativeProfile(locale), normalized = timeText(raw, profile.locale);
  for (const item of profile.patterns) {
    const match = item.regex.exec(normalized);
    if (!match) continue;
    const amount = parseLocalizedCount(match[1], profile.locale);
    if (amount !== null) return { amount, unit: item.unit };
  }
  for (const item of profile.exact) if (containsPhrase(normalized, item.phrase)) return { amount: item.amount, unit: item.unit };
  return null;
}
export function parseLocalizedAgeDays(value: unknown, locale: string, now = Date.now()): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { const at = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])); if (Number.isFinite(at)) return Math.max(0, Math.floor((now - at) / DAY_MS)); }
  const age = parseLocalizedRelativeAge(raw, locale);
  return age ? age.amount * UNIT_DAYS[age.unit] : null;
}
/** A relative time made absolute against the observation time (comments: estimated_relative). */
export function localizedEstimatedUtcTimestamp(value: unknown, locale: string, now: number): string | null {
  if (!Number.isFinite(now)) return null;
  const age = parseLocalizedRelativeAge(value, locale);
  if (!age) return null;
  const at = new Date(now - age.amount * UNIT_MS[age.unit]);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
/** Absolute or relative publication text → a UTC calendar day only. */
export function localizedPublishedUtcDay(value: unknown, locale: string, now = Date.now()): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const absolute = localizedAbsoluteUtcDay(raw, locale);
  if (absolute) return absolute;
  if (/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(raw)) return null;
  const ageDays = parseLocalizedAgeDays(raw, locale, now);
  if (ageDays === null || !Number.isFinite(ageDays)) return null;
  const observed = new Date(now);
  if (Number.isNaN(observed.getTime())) return null;
  return new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), observed.getUTCDate()) - Math.floor(ageDays) * DAY_MS).toISOString().slice(0, 10);
}
