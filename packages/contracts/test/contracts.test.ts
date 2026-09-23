import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommentPageSchema, CreatePlanSchema, VideoFactsSchema } from '../src/index.ts';
import { fixtureVideo } from '../src/fixtures.ts';
import { contentHash } from '../src/hash.ts';

test('hash is independent of object key order but preserves array order', () => {
  assert.equal(contentHash({b: 2, a: 1}), contentHash({a: 1, b: 2}));
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]));
  assert.throws(() => contentHash({bad: undefined}));
});
test('comments preserve count, identity and disabled semantics', () => {
  assert.equal(CommentPageSchema.safeParse({...fixtureVideo.comments_first_page, returned_count: 2}).success, false);
  assert.equal(VideoFactsSchema.safeParse({...fixtureVideo, comments_disabled: true}).success, false);
});
test('plans reject duplicate domains and caller-supplied status', () => {
  const input = {request_id: '11111111-1111-4111-8111-111111111111', fixture_id: 'channel-basic-v1'};
  assert.equal(CreatePlanSchema.safeParse({...input, required_domains: ['ABOUT','ABOUT']}).success, false);
  assert.equal(CreatePlanSchema.safeParse({...input, status: 'COMPLETED'}).success, false);
});
