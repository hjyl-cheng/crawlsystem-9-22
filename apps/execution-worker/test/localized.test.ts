// Ported from the legacy tests oldsystem/services/qybullmq/test/localizedCount.test.js, localizedTime.test.js and youtubeLocale.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { YOUTUBE_UI_LANGUAGE_CODES, LocalizedParseError, findSubscriberCountText, localizedAbsoluteUtcDay, localizedEstimatedUtcTimestamp,
  localizedPublishedUtcDay, parseLocalizedAgeDays, parseLocalizedCount, parseRequiredLocalizedCount } from '../src/youtube/localized.ts';

const CASES: [string, string, number][] = [
  ['pt-BR', '1,2 mil inscritos', 1_200], ['en', '1.2K subscribers', 1_200], ['de', '1,2 Mio. Abonnenten', 1_200_000],
  ['ru', '1,2 млн подписчиков', 1_200_000], ['ko', '1.2만 명의 구독자', 12_000], ['ja', '1.2万人のチャンネル登録者', 12_000],
  ['hi', '1.2 लाख सदस्य', 120_000], ['ar', '١٫٢ مليون مشترك', 1_200_000], ['fa', '۱٫۲ میلیون مشترک', 1_200_000],
  ['bn', '১.২ লা সাবস্ক্রাইবার', 120_000], ['id', '1,2 jt subscriber', 1_200_000], ['tr', '1,2 B abone', 1_200],
  ['vi', '1,2 Tr người đăng ký', 1_200_000], ['th', '๑.๒M ผู้ติดตาม', 1_200_000],
];

test('localized count parsing follows ICU compact notation across scripts', () => {
  for (const [locale, input, expected] of CASES) assert.equal(parseLocalizedCount(input, locale), expected, `${locale}: ${input}`);
});

test('localized count parsing round-trips YouTube market locales', () => {
  assert.equal(YOUTUBE_UI_LANGUAGE_CODES.length, 83);
  for (const locale of YOUTUBE_UI_LANGUAGE_CODES) {
    const formatter = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 2 });
    for (const value of [1_234, 12_000, 120_000, 1_200_000, 120_000_000, 1_200_000_000]) {
      const formatted = formatter.format(value), parsed = parseLocalizedCount(formatted, locale);
      assert.ok(parsed !== null && Math.abs(parsed - value) / value <= 0.011, `${locale}: ${formatted} -> ${parsed}, expected ${value}`);
    }
  }
});

test('localized count parsing distinguishes locale-specific compact symbols', () => {
  assert.equal(parseLocalizedCount('1.2B subscribers', 'en'), 1_200_000_000);
  assert.equal(parseLocalizedCount('1,2 B abone', 'tr'), 1_200);
  assert.equal(parseLocalizedCount('1.2M subscribers', 'en'), 1_200_000);
  assert.equal(parseLocalizedCount('1,2 M subscriber', 'id'), 1_200_000_000);
});

test('unabbreviated localized counts treat separators as grouping', () => {
  assert.equal(parseLocalizedCount('1,234 subscribers', 'en'), 1_234);
  assert.equal(parseLocalizedCount('1.234 inscritos', 'pt-BR'), 1_234);
  assert.equal(parseLocalizedCount('١٬٢٣٤ مشترك', 'ar'), 1_234);
});

test('a handle containing subscriber-label text cannot mask the real subscriber count; an absent row is not a count', () => {
  assert.equal(findSubscriberCountText(['@Olkabone', '1.35M subscribers', '2K videos'], 'en'), '1.35M subscribers');
  assert.equal(findSubscriberCountText(['@global', '8개 동영상'], 'ko'), null);
});

test('a present but unsupported count fails loudly', () => {
  assert.throws(() => parseRequiredLocalizedCount('구독자 수 비공개 형식', 'ko', 'subscriber_count', 'youtube_about'),
    (error: unknown) => error instanceof LocalizedParseError && error.field === 'subscriber_count' && error.locale === 'ko');
});

test('localized relative ages round-trip across YouTube locales', () => {
  const cases: [Intl.RelativeTimeFormatUnit, number, number][] = [['hour', 3, 0], ['day', 2, 2], ['week', 3, 21], ['month', 5, 150], ['year', 2, 730]];
  for (const locale of YOUTUBE_UI_LANGUAGE_CODES) {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    for (const [unit, amount, expected] of cases) { const text = formatter.format(-amount, unit); assert.equal(parseLocalizedAgeDays(text, locale), expected, `${locale}: ${text}`); }
  }
});

test('localized special relative dates and YouTube prefixes are parsed', () => {
  assert.equal(parseLocalizedAgeDays('Streamed yesterday', 'en'), 1);
  assert.equal(parseLocalizedAgeDays('Transmitido há 3 dias', 'pt-BR'), 3);
  assert.equal(parseLocalizedAgeDays('2日前に配信', 'ja'), 2);
  assert.equal(parseLocalizedAgeDays('قبل يومين', 'ar'), 2);
});

test('localized publication text resolves only to a UTC calendar day', () => {
  const now = Date.parse('2026-07-21T23:30:00.000Z');
  assert.equal(localizedPublishedUtcDay('2 days ago', 'en', now), '2026-07-19');
  assert.equal(localizedPublishedUtcDay('2026-07-10', 'en', now), '2026-07-10');
  assert.equal(localizedPublishedUtcDay('2026-02-30', 'en', now), null);
  assert.equal(localizedPublishedUtcDay('unknown', 'en', now), null);
});

test('localized absolute publication dates resolve to a UTC calendar day', () => {
  assert.equal(localizedAbsoluteUtcDay('18 de ago. de 2026', 'pt-BR'), '2026-08-18');
  assert.equal(localizedAbsoluteUtcDay('Aug 18, 2026', 'en-US'), '2026-08-18');
  assert.equal(localizedAbsoluteUtcDay('18 Aug 2026', 'en-GB'), '2026-08-18');
  assert.equal(localizedAbsoluteUtcDay('18 de ago. de 2026', 'en'), null);
  assert.equal(localizedAbsoluteUtcDay('31 de fev. de 2026', 'pt-BR'), null);
});

test('localized absolute dates round-trip across YouTube locales', () => {
  const date = new Date('2026-08-18T00:00:00.000Z');
  for (const locale of YOUTUBE_UI_LANGUAGE_CODES) for (const month of ['long', 'short'] as const) {
    const value = new Intl.DateTimeFormat(locale, { calendar: 'gregory', timeZone: 'UTC', year: 'numeric', month, day: 'numeric' }).format(date);
    assert.equal(localizedAbsoluteUtcDay(value, locale), '2026-08-18', `${locale}/${month}: ${value}`);
  }
});

test('comment ages become timestamps in English and in the pt-BR text the old identity received', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  assert.equal(localizedEstimatedUtcTimestamp('3 days ago', 'en', now), '2026-10-10T12:00:00.000Z');
  assert.equal(localizedEstimatedUtcTimestamp('há 3 dias', 'pt-BR', now), '2026-10-10T12:00:00.000Z');
  assert.equal(localizedEstimatedUtcTimestamp('2 hours ago (edited)', 'en', now), '2026-10-13T10:00:00.000Z');
});
