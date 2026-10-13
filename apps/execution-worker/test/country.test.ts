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
  assert.equal(channelVerified({ badges: [{ style: 'BADGE_STYLE_TYPE_SIMPLE' }] }), false, 'observed badges without a verified one');
  assert.equal(channelVerified({ content: { metadata: { metadata_rows: [{ badges: [] }] }, title: { text: { runs: [{ text: 'Name' }, { attachment: { element: {} } }] } } } }), true,
    'empty row badge lists do not hide the title check mark');
  assert.equal(channelVerified({ content: { title: { text: { runs: [{ text: 'Name' }, { attachment: { icon: 'CHECK_CIRCLE' } }] } } } }), true);
  assert.equal(channelVerified({ content: {} }), null);
});
// Ported from oldsystem qybullmq/test/publicationUrl.test.js and publicationLinks.test.js (batch 4d).
import { linkPurpose, linkTarget, linkType, normalizeUrl } from '@crawlsystem/contracts/links';
test('channel links resolve their tap target, unwrap redirects, drop tracking and classify type and purpose', () => {
  const link = { title: 'Instagram', link: { text: 'instagram.com/abc…', command_runs: [{ on_tap: { payload: { url: 'https://www.youtube.com/redirect?q=https%3A%2F%2Finstagram.com%2Fabc%3Futm_source%3Dyt%26igsh%3D1%26x%3D2' } } }] } };
  assert.equal(normalizeUrl(linkTarget(link)), 'https://instagram.com/abc?x=2');
  assert.equal(normalizeUrl('mailto:Biz@Example.COM', { contacts: true }), 'mailto:biz@example.com');
  assert.equal(normalizeUrl('https://user:pw@example.com'), null, 'credentials are rejected');
  assert.deepEqual(['https://wa.me/1', 'https://x.com/a', 'mailto:a@b.co', 'https://shop.example.com'].map(linkType), ['whatsapp', 'x_twitter', 'email', 'website']);
  assert.equal(linkPurpose('website', 'Loja oficial'), 'public_reference');
  assert.equal(linkPurpose('website', 'Business inquiries'), 'contact');
  assert.equal(linkPurpose('instagram', 'Instagram'), 'contact');
});
// Batch 4e: legacy channel identity, fallbacks and About metric policy (youtubeJs.js:640-836, aboutMetrics.js:43-50).
test('channel identity conflicts fail; title, handle, description and view count follow the legacy fallbacks', async () => {
  const yt = (metadata: Record<string, unknown>, about: Record<string, unknown>, header: Record<string, unknown> = {}) => ({ async getChannel() {
    return { metadata: { avatar: [], ...metadata }, header, tabs: [], has_videos: true, async getAbout() { return { metadata: { links: [], ...about } }; } }; } });
  const id = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
  await assert.rejects(channelFacts(yt({ title: 'x', external_id: 'UCzzzzzzzzzzzzzzzzzzzzzz' }, {}) as never, id), (e: unknown) => e instanceof ScrapeError && e.kind === 'parse');
  const facts = await channelFacts(yt({ external_id: id, vanity_channel_url: 'http://www.youtube.com/@Some.Name' }, { description: '', subscriber_count: '1.2K subscribers' }, { page_title: 'Header Title', description: 'old header text' }) as never, id, undefined, 'en');
  assert.deepEqual([facts.title, facts.handle, facts.about_description], ['Header Title', '@Some.Name', ''], 'an About page saying empty is not replaced by header text');
  assert.deepEqual([facts.total_view_count.value, facts.total_view_count.source], [0, 'youtube_about_missing_view_count']);
  assert.equal(facts.subscriber_count.source, 'youtubei:channel_about');
  assert.deepEqual(facts.available_tabs, ['videos']);
});
