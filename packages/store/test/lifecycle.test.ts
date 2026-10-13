// Ported from oldsystem qybullmq/test/channelDormancy.test.js and publicationTimeEvidence.test.js (batch 6a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityEvidence, addUtcDays, dormantRecheckDelayDays, evaluateActivity, publicationWindow } from '../src/lifecycle.ts';

test('dormant recheck delay is deterministic, inside 30-90 days and identical to the legacy hash', () => {
  // Values computed by the legacy channelDormancy.js for the same inputs.
  for (const [channel, cycle, days] of [['UCtest', 1, 35], ['UCtest', 2, 84], ['UC_x5XG1OV2P6uZZ5FSM9Ttw', 1, 63], ['UC_x5XG1OV2P6uZZ5FSM9Ttw', 7, 41]] as const)
    assert.equal(dormantRecheckDelayDays(channel, cycle), days, `${channel}/${cycle}`);
  assert.throws(() => dormantRecheckDelayDays('UCtest', 0));
  assert.equal(addUtcDays('2026-07-23', 35), '2026-08-27');
});
test('only a complete zero-content scan can enter dormancy', () => {
  assert.equal(evaluateActivity({ recent: 0, uncertain: 0, complete: false }), 'inconclusive');
  assert.equal(evaluateActivity({ recent: 0, uncertain: 1, complete: true }), 'inconclusive');
  assert.equal(evaluateActivity({ recent: 0, uncertain: 0, complete: true }), 'dormant');
  assert.equal(evaluateActivity({ recent: 1, uncertain: 0, complete: false }), 'active');
});
test('publication window: only exact evidence decides; a date on the cutoff day is uncertain', () => {
  const asOf = new Date('2026-10-13T12:00:00.000Z');
  const at = (published_at: string, precision: 'second' | 'date_only' = 'second', status: 'exact' | 'relative' = 'exact') => publicationWindow({ published_at, published_at_status: status, published_at_precision: precision }, asOf);
  assert.equal(at('2026-10-01T00:00:00.000Z'), 'inside');
  assert.equal(at('2026-07-15T12:00:00.000Z'), 'outside', 'exactly 90 days before is outside');
  assert.equal(at('2026-07-15T12:00:01.000Z'), 'inside');
  assert.equal(at('2026-10-14T00:00:00.000Z'), 'after_as_of');
  assert.equal(at('2026-07-15T00:00:00.000Z', 'date_only'), 'cutoff_overlap');
  assert.equal(at('2026-07-14T00:00:00.000Z', 'date_only'), 'outside');
  assert.equal(at('2026-10-01T00:00:00.000Z', 'second', 'relative'), 'unresolved');
});
test('stored evidence: an unfinished live stream is uncertain, unavailable videos do not count', () => {
  const asOf = new Date('2026-10-13T12:00:00.000Z');
  const video = (published_at: string, extra: Record<string, unknown> = {}) => ({ content_type: 'video', published_at, published_at_status: 'exact', published_at_precision: 'second',
    live_ended_at: null, duration_seconds: { value: 60 }, ...extra }) as never;
  assert.deepEqual(activityEvidence([video('2026-01-01T00:00:00.000Z'), video('2026-02-01T00:00:00.000Z')], asOf), { recent: 0, uncertain: 0 });
  assert.deepEqual(activityEvidence([video('2026-01-01T00:00:00.000Z', { content_type: 'live', duration_seconds: { value: null } })], asOf), { recent: 0, uncertain: 1 });
  assert.deepEqual(activityEvidence([video('2026-10-10T00:00:00.000Z'), { unavailable: true } as never], asOf), { recent: 1, uncertain: 0 });
});
