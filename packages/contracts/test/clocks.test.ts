import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_WINDOW_DAYS, CLOCK_NAMES, decideClock, refreshDue, REFRESH_INTERVAL_DAYS, type ClockFacts } from '../src/clocks.ts';

const now = new Date('2026-10-08T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const facts = (extra: Partial<ClockFacts> = {}): ClockFacts => ({ latestPublishedAt: null, newVideosFound: null, emptyDiscoveryRuns: 0, ...extra });
const days = (clock: Parameters<typeof decideClock>[0], outcome: Parameters<typeof decideClock>[1], f = facts()) => decideClock(clock, outcome, f, now);

test('three clocks, one per domain, as in 24.8 §7', () => {
  assert.deepEqual([...CLOCK_NAMES], ['ABOUT', 'VIDEO', 'AGENT']);
});
test('first collection: About 7, Video 7, Agent 60 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'first')), [
    { interval_days: 7, reason: 'first_collection' }, { interval_days: 7, reason: 'first_collection' }, { interval_days: 60, reason: 'first_collection' }]);
});
test('failures schedule a retry: About and Video 3, Agent 14 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'failure').interval_days), [3, 3, 14]);
  assert.ok(CLOCK_NAMES.every(c => days(c, 'failure').reason === 'retry_after_failure'));
});
test('baseline after success: About 7, Video 7, Agent 180 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'success')), [
    { interval_days: 7, reason: 'baseline' }, { interval_days: 7, reason: 'baseline' }, { interval_days: 180, reason: 'baseline' }]);
});
test('a channel publishing now is checked for new videos every 3 days; About too when new videos arrived', () => {
  const active = facts({ latestPublishedAt: daysAgo(ACTIVE_WINDOW_DAYS - 1) });
  assert.deepEqual(days('VIDEO', 'success', active), { interval_days: 3, reason: 'active_publishing' });
  assert.deepEqual(days('ABOUT', 'success', active), { interval_days: 7, reason: 'baseline' }, 'no new videos reported');
  assert.deepEqual(days('ABOUT', 'success', { ...active, newVideosFound: 2 }), { interval_days: 3, reason: 'new_video_active' });
  assert.deepEqual(days('AGENT', 'success', active), { interval_days: 180, reason: 'baseline' });
  const quiet = facts({ latestPublishedAt: daysAgo(ACTIVE_WINDOW_DAYS + 1), newVideosFound: 2 });
  assert.deepEqual(days('ABOUT', 'success', quiet), { interval_days: 7, reason: 'baseline' });
});
test('empty discoveries back off the Video clock up to three times the baseline; unknown counts do not', () => {
  assert.deepEqual(days('VIDEO', 'success', facts({ newVideosFound: 0 })), { interval_days: 9, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('VIDEO', 'success', facts({ newVideosFound: 0, emptyDiscoveryRuns: 3 })), { interval_days: 14, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('VIDEO', 'success', facts({ newVideosFound: 0, emptyDiscoveryRuns: 20 })), { interval_days: 21, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('VIDEO', 'success', facts({ newVideosFound: 1, emptyDiscoveryRuns: 5 })), { interval_days: 7, reason: 'baseline' });
  assert.deepEqual(days('VIDEO', 'success', facts({ newVideosFound: null, emptyDiscoveryRuns: 5 })), { interval_days: 7, reason: 'baseline' });
});
test('the recent-video refresh rides along with a Video run once its 14 days have passed', () => {
  assert.equal(REFRESH_INTERVAL_DAYS, 14);
  assert.equal(refreshDue(daysAgo(1), now), true);
  assert.equal(refreshDue(now.toISOString(), now), true);
  assert.equal(refreshDue(new Date(now.getTime() + 86_400_000).toISOString(), now), false);
  assert.equal(refreshDue(null, now), true, 'never refreshed');
});
test('an operator-pinned interval replaces the policy; a retry never waits longer than it', () => {
  const active = facts({ latestPublishedAt: daysAgo(1) });
  assert.deepEqual(decideClock('VIDEO', 'success', active, now, 14), { interval_days: 14, reason: 'manual_override' }, 'even an active channel');
  assert.deepEqual(decideClock('AGENT', 'first', facts(), now, 30), { interval_days: 30, reason: 'manual_override' });
  assert.deepEqual(decideClock('ABOUT', 'failure', facts(), now, 1), { interval_days: 1, reason: 'retry_after_failure' });
  assert.deepEqual(decideClock('AGENT', 'failure', facts(), now, 90), { interval_days: 14, reason: 'retry_after_failure' });
  assert.deepEqual(decideClock('ABOUT', 'success', facts(), now, null), { interval_days: 7, reason: 'baseline' }, 'null means automatic');
});
