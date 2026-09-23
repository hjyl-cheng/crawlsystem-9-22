import { ChannelFactsSchema, VideoFactsSchema, FrozenInputSchema, CONTRACT_VERSION, type Domain, type FrozenInput } from './index.ts';
const time = '2026-09-23T00:00:00.000Z';
const metric = (value: number) => ({ value, status: 'exact' as const, source: 'fixture:channel-basic-v1', observed_at: time });
export const fixtureChannel = ChannelFactsSchema.parse({
  channel_id: 'fixture:channel:basic', channel_url: 'https://example.invalid/channel/basic', title: 'M1 固定样本频道',
  handle: '@m1-fixture', avatar_url: null, summary: '仅用于隔离开发验证', about_description: '固定样本，不是真实采集数据。',
  country: null, country_code: null, country_source: null, joined_at: null, joined_date_text: null, joined_at_precision: 'unknown',
  keywords: ['fixture'], available_tabs: ['videos'], external_links: [], subscriber_count: metric(100), total_view_count: metric(500), total_video_count: metric(1),
  is_verified: null, is_family_safe: null, youtube_business_email_available: null, observed_at: time, source: 'fixture:channel-basic-v1',
});
export const fixtureVideo = VideoFactsSchema.parse({
  channel_id: fixtureChannel.channel_id, source_content_id: 'fixture:video:basic', content_type: 'video', content_type_source: 'fixture',
  url: 'https://example.invalid/watch/basic', title: 'M1 固定样本视频', description: '测试视频元数据', thumbnail_url: null, keywords: [], hashtags: [],
  published_at: time, published_text_raw: time, published_at_status: 'exact', published_at_precision: 'second', published_at_source: 'fixture',
  duration_seconds: metric(60), view_count: metric(500), like_count: metric(10), comment_count: metric(1), comments_disabled: false,
  comments_first_page: { version: 1, collected_at: time, sort: 'TOP_COMMENTS', total_count: 1, returned_count: 1, comments: [{
    comment_id: 'fixture:comment:basic', position: 1, text: '固定样本评论', author_name: 'Fixture Author', author_channel_id: null, author_url: null, author_avatar_url: null,
    published_at_utc: time, published_text_raw: time, published_at_status: 'exact', is_edited: false, like_count: 0, reply_count: 0, is_pinned: false, is_channel_owner: false, is_verified: null, is_hearted: false,
  }] }, access_status: 'public', access_status_source: 'fixture', is_members_only: false, live_scheduled_at: null, live_started_at: null, live_ended_at: null, observed_at: time, extractor_version: CONTRACT_VERSION,
});
export function createFrozenFixture(required_domains: Domain[], deadline_at: string): FrozenInput {
  return FrozenInputSchema.parse({ schema_version: CONTRACT_VERSION, source_mode: 'fixture', fixture_id: 'channel-basic-v1', channel_id: fixtureChannel.channel_id,
    required_domains, target_video_ids: [fixtureVideo.source_content_id], reference_time: time, deadline_at, max_attempts: 3,
    sample: { about: structuredClone(fixtureChannel), videos: [structuredClone(fixtureVideo)] } });
}
