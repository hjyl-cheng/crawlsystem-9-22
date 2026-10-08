import test from 'node:test';
import assert from 'node:assert/strict';
import { nextChangeProbability, planRecentSampling } from '../src/recent-sampling.ts';

/** Legacy Recent Sampling (incrementalVideoPlanner.js video-plan-1); 5,000 random pools matched it exactly when ported. */
const now = Date.parse('2026-10-08T10:00:00Z'), DAY = 86_400_000;
const row = (video_id: string, publishedDaysAgo: number, statsDaysAgo: number | null, change_probability: number | null = null) =>
  ({ video_id, published_at: now - publishedDaysAgo * DAY, stats_observed_at: statsDaysAgo === null ? null : now - statsDaysAgo * DAY, change_probability });

test('never-read and stale videos are re-read first; recently read ones wait', () => {
  const plan = planRecentSampling([row('fresh', 2, 0.5, 0.05), row('never', 10, null), row('stale', 20, 9, 0.2), row('likely', 1, 2, 0.9)], now);
  assert.equal(plan.recent_count, 4);
  assert.equal(plan.stale_ratio, 0.5, 'never read and 9 days old are stale (7 days)');
  assert.deepEqual(plan.video_ids, ['never', 'stale'], 'scored, capped by demand × 0.75');
  assert.equal(plan.candidate_count, 2, 'read 12 hours or 2 days ago scores below 0.55, even when likely to change');
});

test('at most 20 videos are re-read per update', () => {
  const pool = Array.from({ length: 40 }, (_, i) => row(`v${String(i).padStart(2, '0')}`, i % 30, null));
  const plan = planRecentSampling(pool, now);
  assert.equal(plan.video_ids.length, 20);
  assert.deepEqual(planRecentSampling([], now), { recent_count: 0, stale_ratio: 0, candidate_count: 0, video_ids: [] });
});

test('the change probability learns views at 0.70 and likes and comments at 0.15 each (EWMA 0.4)', () => {
  const before = { view_count: 100, like_count: 10, comment_count: 1 };
  assert.equal(nextChangeProbability(before, { view_count: 120, like_count: 10, comment_count: 1 }, null), 0.70);
  assert.equal(nextChangeProbability(before, { view_count: 100, like_count: 11, comment_count: 2 }, 0.5), 0.4 * 0.30 + 0.6 * 0.5);
  assert.equal(nextChangeProbability(before, { view_count: null, like_count: null, comment_count: null }, 0.3), 0.3, 'nothing comparable keeps it');
});
