import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_WINDOW_DAYS, CLOCK_NAMES, clocksOf, decideClock, type ClockFacts } from '../src/clocks.ts';

const now = new Date('2026-10-08T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const facts = (extra: Partial<ClockFacts> = {}): ClockFacts => ({ latestPublishedAt: null, newVideosFound: null, emptyDiscoveryRuns: 0, ...extra });
const days = (clock: Parameters<typeof decideClock>[0], outcome: Parameters<typeof decideClock>[1], f = facts()) => decideClock(clock, outcome, f, now);

test('VIDEO advances discovery and refresh; the other domains advance their own clock', () => {
  assert.deepEqual(clocksOf('VIDEO'), ['DISCOVERY', 'REFRESH']);
  assert.deepEqual(clocksOf('ABOUT'), ['ABOUT']);
  assert.deepEqual(clocksOf('AGENT'), ['AGENT']);
});
test('first collection: About 7, discovery 7, refresh 14, Agent 60 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'first')), [
    { interval_days: 7, reason: 'first_collection' }, { interval_days: 7, reason: 'first_collection' },
    { interval_days: 14, reason: 'first_collection' }, { interval_days: 60, reason: 'first_collection' }]);
});
test('failures schedule a retry: About and discovery 3, refresh 7, Agent 14 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'failure').interval_days), [3, 3, 7, 14]);
  assert.ok(CLOCK_NAMES.every(c => days(c, 'failure').reason === 'retry_after_failure'));
});
test('baseline after success: About 7, discovery 7, refresh 14, Agent 180 days', () => {
  assert.deepEqual(CLOCK_NAMES.map(c => days(c, 'success')), [
    { interval_days: 7, reason: 'baseline' }, { interval_days: 7, reason: 'baseline' }, { interval_days: 14, reason: 'baseline' }, { interval_days: 180, reason: 'baseline' }]);
});
test('a channel publishing now is checked every 3 days for new videos; About too when new videos arrived', () => {
  const active = facts({ latestPublishedAt: daysAgo(ACTIVE_WINDOW_DAYS - 1) });
  assert.deepEqual(days('DISCOVERY', 'success', active), { interval_days: 3, reason: 'active_publishing' });
  assert.deepEqual(days('ABOUT', 'success', active), { interval_days: 7, reason: 'baseline' }, 'no new videos reported');
  assert.deepEqual(days('ABOUT', 'success', { ...active, newVideosFound: 2 }), { interval_days: 3, reason: 'new_video_active' });
  assert.deepEqual(days('REFRESH', 'success', active), { interval_days: 14, reason: 'baseline' });
  const quiet = facts({ latestPublishedAt: daysAgo(ACTIVE_WINDOW_DAYS + 1), newVideosFound: 2 });
  assert.deepEqual(days('ABOUT', 'success', quiet), { interval_days: 7, reason: 'baseline' });
});
test('empty discoveries back off up to three times the baseline; unknown counts do not', () => {
  assert.deepEqual(days('DISCOVERY', 'success', facts({ newVideosFound: 0 })), { interval_days: 9, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('DISCOVERY', 'success', facts({ newVideosFound: 0, emptyDiscoveryRuns: 3 })), { interval_days: 14, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('DISCOVERY', 'success', facts({ newVideosFound: 0, emptyDiscoveryRuns: 20 })), { interval_days: 21, reason: 'discovery_empty_backoff' });
  assert.deepEqual(days('DISCOVERY', 'success', facts({ newVideosFound: 1, emptyDiscoveryRuns: 5 })), { interval_days: 7, reason: 'baseline' });
  assert.deepEqual(days('DISCOVERY', 'success', facts({ newVideosFound: null, emptyDiscoveryRuns: 5 })), { interval_days: 7, reason: 'baseline' });
});
