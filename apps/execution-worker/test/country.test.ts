// Ported from oldsystem qybullmq/test/agentCountryPolicy.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCountry } from '../src/youtube/country.ts';
import { channelFacts, channelVerified } from '../src/youtube/web-scrape.ts';
import { ScrapeError } from '../src/youtube/scrape.ts';

test('About countries in English, Portuguese and other YouTube languages resolve to one ISO code', () => {
  for (const [label, code] of [['Brazil', 'BR'], ['Brasil', 'BR'], ['United States', 'US'], ['Estados Unidos', 'US'], ['Türkiye', 'TR'], ['Viet Nam', 'VN'],
    ['Republic of Korea', 'KR'], ['Coreia do Sul', 'KR'], ['Deutschland', 'DE'], ['日本', 'JP'], ['us', 'US'], ['Hong Kong', 'HK'], ['Trinidad & Tobago', 'TT']] as const)
    assert.equal(canonicalCountry(label).code, code, label);
  assert.deepEqual(canonicalCountry('Brasil'), { raw: 'Brasil', code: 'BR', name: 'Brazil' });
  assert.deepEqual(canonicalCountry(''), { raw: null, code: null, name: null });
  assert.equal(canonicalCountry('Atlantis').code, null);
});
test('an observed but unknown About country fails instead of skipping country inference', async () => {
  const yt = (country: string) => ({ async getChannel() { return { metadata: { title: 'channel', avatar: [] }, tabs: ['Home'], async getAbout() { return { metadata: { country, links: [] } }; } }; } });
  const facts = await channelFacts(yt('Brazil') as never, 'UC_x5XG1OV2P6uZZ5FSM9Ttw');
  assert.deepEqual([facts.country, facts.country_code, facts.country_source], ['Brazil', 'BR', 'youtubei:about']);
  await assert.rejects(channelFacts(yt('Atlantis') as never, 'UC_x5XG1OV2P6uZZ5FSM9Ttw'), (e: unknown) => e instanceof ScrapeError && e.kind === 'parse');
});
// Ported from oldsystem qybullmq/test/youtubeJs.test.js (channel verification, batch 4b).
test('channel verification reads the author flag, then badges, then title attachments, else stays unknown', () => {
  assert.equal(channelVerified({ author: { is_verified: false }, badges: [{ style: 'BADGE_STYLE_TYPE_VERIFIED' }] }), false, 'the explicit flag wins');
  assert.equal(channelVerified({ badges: [{ style: 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' }] }), true);
  assert.equal(channelVerified({ content: { metadata: { metadata_rows: [{ badges: [{ tooltip: 'Verified' }] }] } } }), true);
  assert.equal(channelVerified({ badges: [] }), false, 'observed badges without a verified one');
  assert.equal(channelVerified({ content: { title: { text: { runs: [{ text: 'Name' }, { attachment: { icon: 'CHECK_CIRCLE' } }] } } } }), true);
  assert.equal(channelVerified({ content: {} }), null);
});
