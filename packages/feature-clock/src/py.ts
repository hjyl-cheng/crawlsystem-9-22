import { createHash } from 'node:crypto';

/**
 * Python numeric semantics the legacy engine relies on, reproduced exactly so the port decides the
 * same days: round() is half-to-even, sum() of floats is Neumaier-compensated (CPython 3.12),
 * statistics.pstdev is the correctly rounded root of the exact variance, and timedelta(days=x)
 * rounds to whole microseconds half-to-even. exp/log/pow come from V8 rather than the C library
 * and may differ in the last bit; that never moves a whole-day decision except on an exact boundary.
 */

/** Python round(x) for a float: nearest integer, ties to even. */
export function roundHalfEven(x: number): number {
  const rounded = cRound(x);
  return Math.abs(x - rounded) === 0.5 ? 2 * cRound(x / 2) : rounded;
}

/** C round(): nearest integer, ties away from zero. */
function cRound(x: number): number {
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
}

/** Python `a or b` for an optional number: falls through on null and on 0. */
export function or<T>(value: number | null, fallback: T): number | T {
  return value === null || value === 0 ? fallback : value;
}

/** Python sum() over floats (CPython 3.12+: Neumaier compensated summation). */
export function sum(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0 + values[0]!, compensation = 0;
  for (let index = 1; index < values.length; index += 1) {
    const x = values[index]!, t = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
    total = t;
  }
  return compensation !== 0 && Number.isFinite(compensation) ? total + compensation : total;
}

/** statistics.median. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  if (sorted.length === 0) throw new Error('median requires at least one value');
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** statistics.pstdev: the exact population variance, square-rooted with correct rounding. */
export function pstdev(values: readonly number[]): number {
  if (values.length === 0) throw new Error('pstdev requires at least one value');
  const ratios = values.map(exactRatio);
  const shift = ratios.reduce((max, [, exponent]) => Math.max(max, exponent), 0);
  const scaled = ratios.map(([numerator, exponent]) => numerator << BigInt(shift - exponent));
  const count = BigInt(values.length);
  const total = scaled.reduce((a, b) => a + b, 0n), squares = scaled.reduce((a, b) => a + b * b, 0n);
  // mean square deviation = (n·Σx² − (Σx)²) / (n² · 2^(2·shift)), exactly.
  return sqrtOfFraction(count * squares - total * total, count * count << BigInt(2 * shift));
}

/** x = numerator / 2^exponent exactly. */
function exactRatio(x: number): [bigint, number] {
  if (!Number.isFinite(x)) throw new Error('pstdev requires finite values');
  let exponent = 0;
  while (!Number.isInteger(x)) { x *= 2; exponent += 1; }
  return [BigInt(x), exponent];
}

/** statistics._float_sqrt_of_frac: sqrt(n/m) correctly rounded, via round-to-odd at 109 bits. */
function sqrtOfFraction(n: bigint, m: bigint): number {
  if (n === 0n) return 0;
  const q = Math.floor((bitLength(n) - bitLength(m) - 109) / 2);
  if (q >= 0) return Number(sqrtRoundToOdd(n, m << BigInt(2 * q)) << BigInt(q));
  return Number(sqrtRoundToOdd(n << BigInt(-2 * q), m)) / 2 ** -q;
}

function sqrtRoundToOdd(n: bigint, m: bigint): bigint {
  const a = isqrt(n / m);
  return a * a * m !== n ? a | 1n : a;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** math.isclose. */
export function isClose(a: number, b: number, { relTol = 1e-9, absTol = 0 } = {}): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol;
}

/** Order-preserving de-duplication (Python dict.fromkeys). */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Python string ordering: by code point, not UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const left = [...a], right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Python str.casefold for the characters where it differs from per-character lower-casing. */
const FOLDS: Record<string, string> = {
  'ß': 'ss', 'ẞ': 'ss', 'ς': 'σ', 'ſ': 's', 'µ': 'μ', 'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε', 'ẛ': 'ṡ',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', 'ŉ': 'ʼn', 'ǰ': 'ǰ', 'ΐ': 'ΐ', 'ΰ': 'ΰ', 'և': 'եւ',
};
export function casefold(text: string): string {
  return [...text].map(character => FOLDS[character] ?? character.toLowerCase()).join('');
}

/** The first 8 bytes of SHA-256(text), big-endian, modulo `modulus`. */
export function sha256Mod(text: string, modulus: number): number {
  return Number(createHash('sha256').update(text, 'utf8').digest().readBigUInt64BE(0) % BigInt(modulus));
}

/** timedelta(days=x) in whole microseconds, rounding the leftover half-to-even like CPython. */
export function daysToMicros(days: number): number {
  const whole = Math.trunc(days);
  let total = whole * 86_400_000_000;
  const fraction = days - whole;
  if (fraction === 0) return total;
  const scaled = 86_400_000_000 * fraction, scaledWhole = Math.trunc(scaled);
  total += scaledWhole;
  const leftover = scaled - scaledWhole;
  if (leftover !== 0) {
    let micros = cRound(leftover);
    if (Math.abs(micros - leftover) === 0.5) {
      const odd = Math.abs(total) % 2;
      micros = 2 * cRound((leftover + odd) * 0.5) - odd;
    }
    total += micros;
  }
  return total;
}
