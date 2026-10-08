import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_NAMES, CLOCK_POLICY_VERSION, OVERRIDE_DAYS } from '../src/clocks.ts';
import { ChannelClockOverrideSchema, ChannelClockSchema } from '../src/index.ts';
import { ACTIVE_POLICY } from '../../feature-clock/src/index.ts';

test('three clocks, one per domain, as in 24.8 §7', () => {
  assert.deepEqual([...CLOCK_NAMES], ['ABOUT', 'VIDEO', 'AGENT']);
});
test('clocks carry the policy version of the ported legacy algorithm', () => {
  assert.equal(CLOCK_POLICY_VERSION, ACTIVE_POLICY.policy_version);
});
test('operators may pin a clock only to the offered intervals, or return it to the policy', () => {
  const pin = (interval_days: unknown) => ChannelClockOverrideSchema.safeParse({ clock: 'VIDEO', interval_days, expected_version: 1 }).success;
  assert.ok(OVERRIDE_DAYS.every(pin));
  assert.ok(pin(null));
  assert.ok(!pin(4) && !pin(0) && !pin(400));
});
test('a clock lists the reason codes behind its due day', () => {
  const clock = { clock: 'ABOUT', due_at: '2026-10-15T00:00:00.000Z', next_due_at: '2026-10-15T00:00:00.000Z', interval_days: 7, policy_version: 'v16-rule-7', retry_at: null,
    reasons: ['about_priority_medium', 'partial_retry_cap'], last_success_at: null, last_attempt_at: null, last_plan_id: null, override_days: null };
  assert.ok(ChannelClockSchema.safeParse(clock).success);
  assert.ok(!ChannelClockSchema.safeParse({ ...clock, reasons: 'baseline' }).success);
});
