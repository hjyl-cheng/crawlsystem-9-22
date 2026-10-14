// Legacy canonical country name (oldsystem qybullmq/src/agentCountryPolicy.js:4-40): the CLDR English name of an
// ISO 3166-1 alpha-2 code, as published in country_name (channelPublicationCurrent.js:263) and the crawler country fact.
const english = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryEnglishName(code: string | null | undefined): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  const name = english.of(code);
  return name && name !== code ? name : null;
}
/**
 * The profile model's own spelling where its prior catalog and language table differ from CLDR; the model input
 * must match them or one country counts twice (rule register A-37/A-38).
 */
export const PROFILE_COUNTRY_NAME_OVERRIDES: Readonly<Record<string, string>> = { HK: 'Hong Kong', MO: 'Macau', TR: 'Turkey' };
/** Code to name table for the profile model input, written to apps/profile-agent/profile_agent/country_names.json. */
export function profileCountryNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b), name = countryEnglishName(code);
    let region = code;
    try { region = new Intl.Locale(`und-${code}`).region ?? code; } catch { /* keep the code */ }
    if (name && region === code) out[code] = PROFILE_COUNTRY_NAME_OVERRIDES[code] ?? name;
  }
  return out;
}
