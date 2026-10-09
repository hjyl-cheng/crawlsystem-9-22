import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarMonths, retryAt, runWindow, settleQueryRun } from '../src/query-clock.ts';

const now = new Date('2026-01-31T10:00:00.000Z');
const binding = (state: 'BOOTSTRAP' | 'ACTIVE' | 'COOLDOWN', extra = {}) => ({ state, cadence: null, cadence_override: null, empty_runs: 0, ...extra });

test('a new binding searches this year; later runs search this week or this month', () => {
  assert.equal(runWindow(binding('BOOTSTRAP')), 'THIS_YEAR');
  assert.equal(runWindow(binding('ACTIVE', { cadence: 'WEEK' })), 'THIS_WEEK');
  assert.equal(runWindow(binding('ACTIVE', { cadence: 'MONTH' })), 'THIS_MONTH');
  assert.equal(runWindow(binding('ACTIVE', { cadence: 'WEEK', cadence_override: 'MONTH' })), 'THIS_MONTH', 'an operator override wins');
});

test('three or more new qualified channels make a binding weekly, one or two monthly', () => {
  assert.deepEqual(settleQueryRun(binding('BOOTSTRAP'), 3, now), { state: 'ACTIVE', cadence: 'WEEK', next_run_at: new Date('2026-02-07T10:00:00.000Z'), empty_runs: 0 });
  assert.deepEqual(settleQueryRun(binding('ACTIVE', { empty_runs: 2 }), 1, now), { state: 'ACTIVE', cadence: 'MONTH', next_run_at: new Date('2026-02-28T10:00:00.000Z'), empty_runs: 0 }, 'calendar month, clamped');
  assert.equal(settleQueryRun(binding('ACTIVE', { cadence_override: 'MONTH' }), 5, now).next_run_at!.toISOString(), '2026-02-28T10:00:00.000Z', 'the override sets the date');
});

test('empty runs cool a binding down after three, and a further empty run makes it dormant', () => {
  assert.deepEqual(settleQueryRun(binding('ACTIVE', { empty_runs: 1 }), 0, now), { state: 'ACTIVE', cadence: 'MONTH', next_run_at: new Date('2026-02-28T10:00:00.000Z'), empty_runs: 2 });
  assert.deepEqual(settleQueryRun(binding('ACTIVE', { empty_runs: 2 }), 0, now), { state: 'COOLDOWN', cadence: 'MONTH', next_run_at: new Date('2026-04-30T10:00:00.000Z'), empty_runs: 3 });
  assert.deepEqual(settleQueryRun(binding('COOLDOWN', { empty_runs: 3 }), 0, now), { state: 'DORMANT', cadence: 'MONTH', next_run_at: null, empty_runs: 4 });
  assert.equal(settleQueryRun(binding('COOLDOWN', { empty_runs: 3 }), 2, now).state, 'ACTIVE', 'results bring it back');
});

test('calendar months and retries', () => {
  assert.equal(addCalendarMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString(), '2028-02-29T00:00:00.000Z', 'leap year');
  assert.equal(addCalendarMonths(new Date('2026-03-15T08:30:00Z'), 1).toISOString(), '2026-04-15T08:30:00.000Z');
  assert.deepEqual([1, 2, 3, 6, 9].map(n => (retryAt(n, now).getTime() - now.getTime()) / 3_600_000), [1, 2, 4, 24, 24]);
});
