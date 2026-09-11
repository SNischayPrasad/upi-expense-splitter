/**
 * money.js — integer-paise arithmetic.
 *
 * Every monetary value in this application is an integer number of paise.
 * 1 rupee = 100 paise, so `12345` means ₹123.45. Floating point is used only
 * at the parse boundary (and immediately rounded) and never in the domain model.
 *
 * Pure module: no DOM, no storage, no globals.
 */

/** Largest magnitude we accept, in paise (₹10,00,00,000). */
export const MAX_PAISE = 100000000000;

const DIGITS_ONLY = /^\d+$/;

/**
 * Parse user input into integer paise.
 * Accepts "1234", "1234.5", "1,234.50", "₹1,234.50", " 1234 ", "1_234".
 * @param {string|number} input
 * @returns {number} integer paise
 * @throws {RangeError} on empty, malformed, or out-of-range input
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError('Amount must be a finite number');
    return parseAmount(input.toFixed(2));
  }
  if (typeof input !== 'string') throw new RangeError('Amount must be text or a number');

  let s = input.trim().replace(/[₹\s,_]/g, '');
  if (s === '') throw new RangeError('Enter an amount');

  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  const parts = s.split('.');
  if (parts.length > 2) throw new RangeError('Amount has more than one decimal point');

  const whole = parts[0] === '' ? '0' : parts[0];
  const frac = parts.length === 2 ? parts[1] : '';

  if (!DIGITS_ONLY.test(whole)) throw new RangeError('Amount must contain only digits');
  if (frac !== '' && !DIGITS_ONLY.test(frac)) throw new RangeError('Amount must contain only digits');
  if (frac.length > 2) throw new RangeError('Amount cannot have more than 2 decimal places');

  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(paise)) throw new RangeError('Amount is too large');
  if (paise > MAX_PAISE) throw new RangeError('Amount is too large');

  return negative ? -paise : paise;
}

/**
 * Format paise using the Indian digit-grouping convention (1,23,45,678.90).
 * @param {number} paise
 * @param {{symbol?: boolean, sign?: boolean, compact?: boolean}} [opts]
 * @returns {string}
 */
export function formatPaise(paise, opts = {}) {
  const { symbol = false, sign = false, compact = false } = opts;
  const n = Math.trunc(paise);
  const negative = n < 0;
  const abs = Math.abs(n);

  // Compact thresholds are expressed in PAISE: 1 crore = 1e9 paise, 1 lakh = 1e7 paise.
  let body;
  if (compact && abs >= 1000000000) {
    body = trimZeros((abs / 1000000000).toFixed(2)) + 'Cr';
  } else if (compact && abs >= 10000000) {
    body = trimZeros((abs / 10000000).toFixed(2)) + 'L';
  } else {
    const rupees = Math.floor(abs / 100);
    const paisePart = String(abs % 100).padStart(2, '0');
    body = `${groupIndian(rupees)}.${paisePart}`;
  }

  let prefix = '';
  if (negative) prefix = '-';
  else if (sign && n > 0) prefix = '+';

  return `${prefix}${symbol ? '₹' : ''}${body}`;
}

function trimZeros(s) {
  return s.replace(/\.?0+$/, '');
}

/** Indian grouping: last 3 digits, then groups of 2. */
function groupIndian(rupees) {
  const s = String(rupees);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

/**
 * Format with the rupee symbol. Shorthand for formatPaise(p, {symbol: true, ...}).
 * @param {number} paise
 * @param {object} [opts]
 */
export function formatINR(paise, opts = {}) {
  return formatPaise(paise, { ...opts, symbol: true });
}

/**
 * Split `total` paise into `n` parts as evenly as possible.
 * The returned array always sums to exactly `total`; the remainder paise go to
 * the first `|remainder|` entries so the result is deterministic.
 * @param {number} total integer paise (may be negative for refunds)
 * @param {number} n number of parts, >= 1
 * @returns {number[]}
 */
export function splitEvenly(total, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('Need at least one participant');
  if (!Number.isInteger(total)) throw new RangeError('Total must be an integer number of paise');

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;

  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sign * (base + (i < remainder ? 1 : 0));
  return out;
}

/**
 * Allocate `total` paise across `weights` using the largest-remainder
 * (Hamilton) method, guaranteeing the result sums to exactly `total`.
 * @param {number} total integer paise
 * @param {number[]} weights non-negative, not all zero
 * @returns {number[]}
 */
export function allocateByWeights(total, weights) {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new RangeError('Need at least one weight');
  }
  if (!Number.isInteger(total)) throw new RangeError('Total must be an integer number of paise');

  let weightSum = 0;
  for (const w of weights) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new RangeError('Weights must be non-negative finite numbers');
    }
    weightSum += w;
  }
  if (weightSum <= 0) throw new RangeError('Weights cannot all be zero');

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);

  const exact = weights.map((w) => (abs * w) / weightSum);
  const floors = exact.map((x) => Math.floor(x));
  let assigned = floors.reduce((a, b) => a + b, 0);
  let left = abs - assigned;

  // Distribute the leftover paise to the largest fractional remainders.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  const out = floors.slice();
  for (let k = 0; k < left; k++) out[order[k % order.length].i] += 1;

  return out.map((v) => sign * v);
}

/**
 * Sum paise values with a safety guard.
 * @param {number[]} values
 * @returns {number}
 */
export function sum(values) {
  let acc = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new RangeError('Can only sum integer paise');
    acc += v;
    // Guard every intermediate result as well as the return value.  A later
    // negative value must not be allowed to hide an unsafe transient total.
    if (!Number.isSafeInteger(acc)) throw new RangeError('Sum overflowed the safe integer range');
  }
  return acc;
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round a rupee float to paise. Used only at input boundaries. */
export function rupeesToPaise(rupees) {
  return Math.round(rupees * 100);
}

/** Paise -> rupee number. Used only for display/serialisation to UPI. */
export function paiseToRupees(paise) {
  return paise / 100;
}

/** Serialise paise as the `am=` value of a UPI URI: always 2 decimals, no grouping. */
export function paiseToUpiAmount(paise) {
  const abs = Math.abs(Math.trunc(paise));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
