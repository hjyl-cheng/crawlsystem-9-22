import test from 'node:test';
import assert from 'node:assert/strict';
import { casefold, daysToMicros, median, pstdev, roundHalfEven, sum } from '../src/py.ts';
import { dispatchSlot, formatInstant, parseInstant } from '../src/index.ts';

/** Expected values are what CPython 3.12 returns for the same input. */

test('round() is half-to-even', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, 16.5, 0.49999999999999994].map(roundHalfEven), [0, 2, 2, -0, 16, 0]);
});

test('sum() of floats is compensated, statistics.pstdev is correctly rounded', () => {
  assert.equal(sum(new Array(10).fill(0.1)), 1.0);
  assert.equal(pstdev([1.0, 2.0, 3.0, 4.0]), 1.118033988749895);
  assert.equal(pstdev([0.1, 0.2, 0.3]), 0.0816496580927726);
  assert.equal(median([3.0, 1.0, 2.0, 10.0]), 2.5);
});

test('timedelta(days=x) rounds to whole microseconds half-to-even', () => {
  assert.deepEqual([1 / 3, 0.5 / 86400e6, 1.5 / 86400e6, 2.5 / 86400e6].map(daysToMicros), [28_800_000_000, 0, 2, 2]);
});

test('instants keep microseconds and print as Python isoformat()', () => {
  const at = parseInstant('2026-03-17T20:55:08.790931+08:00');
  assert.equal(formatInstant(at), '2026-03-17T12:55:08.790931Z');
  assert.equal(formatInstant(parseInstant('2026-03-16T01:39:04Z')), '2026-03-16T01:39:04Z');
});

test('casefold and the dispatch slot hash match Python', () => {
  assert.equal(casefold('Straße'), 'strasse');
  assert.equal(casefold('ΣΑΣ'), 'σασ');
  assert.equal(dispatchSlot('UCx'), 354);
});
