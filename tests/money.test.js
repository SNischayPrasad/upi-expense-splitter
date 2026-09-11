/**
 * money.test.js — exhaustive suite for src/core/money.js.
 *
 * Money is an integer number of paise everywhere in SplitUPI, so the properties
 * that matter most are exactness properties: every split and every allocation
 * must sum back to the original total, with no paise invented and none lost.
 * The loops below are written as property checks over wide input ranges rather
 * than a handful of hand-picked examples.
 *
 * Run with: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAISE,
  parseAmount,
  formatPaise,
  formatINR,
  splitEvenly,
  allocateByWeights,
  sum,
  clamp,
  rupeesToPaise,
  paiseToRupees,
  paiseToUpiAmount,
} from '../src/core/money.js';

/* ------------------------------------------------------------------ *
 * Test helpers (pure, deterministic — no Math.random anywhere)
 * ------------------------------------------------------------------ */

/**
 * Deterministic linear-congruential PRNG so the property loops below produce
 * the same inputs on every run and a failure is always reproducible.
 * @param {number} seed
 * @returns {() => number} next float in [0, 1)
 */
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Signed arithmetic legitimately produces `-0` (e.g. the empty tail of a
 * negative split). `-0` is numerically equal to `0` but `deepStrictEqual`
 * distinguishes them, so normalise before comparing shapes.
 * @param {number[]} values
 * @returns {number[]}
 */
function noNegZero(values) {
  return values.map((v) => (v === 0 ? 0 : v));
}

/**
 * Assert that a rupee body uses Indian digit grouping: the last group has three
 * digits and every group before it has exactly two (1,23,45,678).
 * @param {string} body grouped rupee digits, no symbol, no decimals
 */
function assertIndianGrouping(body) {
  assert.match(
    body,
    /^(?:\d{1,3}|\d{1,2}(?:,\d{2})*,\d{3})$/,
    `"${body}" is not grouped the Indian way`,
  );
}

/**
 * Split a formatted amount into its prefix (sign + symbol) and its numeric body.
 * @param {string} text
 * @returns {{prefix: string, body: string}}
 */
function splitFormatted(text) {
  const m = /^([-+]?₹?)(.*)$/.exec(text);
  assert.ok(m, `"${text}" does not start with an optional sign and symbol`);
  return { prefix: m[1], body: m[2] };
}

/* ------------------------------------------------------------------ *
 * MAX_PAISE
 * ------------------------------------------------------------------ */

test('MAX_PAISE is a safe integer number of paise', () => {
  assert.equal(MAX_PAISE, 100000000000);
  assert.ok(Number.isSafeInteger(MAX_PAISE));
  assert.equal(MAX_PAISE % 100, 0, 'the cap is a whole number of rupees');
});

/* ------------------------------------------------------------------ *
 * parseAmount — accepted input
 * ------------------------------------------------------------------ */

test('parseAmount: canonical accepted forms', () => {
  const cases = [
    ['1234', 123400],
    ['1234.5', 123450],
    ['1234.50', 123450],
    ['₹1,23,456.78', 12345678],
    [' 12 ', 1200],
    ['-50.25', -5025],
    ['+7', 700],
    ['.5', 50],
    ['0', 0],
    ['0.00', 0],
    ['0.01', 1],
    ['.05', 5],
    ['1,234.50', 123450],
    ['₹1234.50', 123450],
    ['1_234', 123400],
    ['  ₹ 1, 234 . 5 0 ', 123450],
    ['-0.01', -1],
    ['+1,000', 100000],
    ['99', 9900],
    ['99.99', 9999],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseAmount(input), expected, `parseAmount(${JSON.stringify(input)})`);
  }
});

test('parseAmount: a single fraction digit is padded, not truncated', () => {
  assert.equal(parseAmount('1.1'), 110);
  assert.equal(parseAmount('1.10'), 110);
  assert.equal(parseAmount('1.01'), 101);
  assert.equal(parseAmount('0.5'), 50);
  assert.equal(parseAmount('0.05'), 5);
});

test('parseAmount: ₹, commas, underscores and spaces are cosmetic', () => {
  const decorations = [
    '123456.78',
    '₹123456.78',
    '1,23,456.78',
    '₹1,23,456.78',
    '  ₹1,23,456.78  ',
    '1_23_456.78',
    '₹ 1,23,456 . 78',
  ];
  for (const text of decorations) {
    assert.equal(parseAmount(text), 12345678, `parseAmount(${JSON.stringify(text)})`);
  }
});

test('parseAmount: accepts exactly MAX_PAISE and rejects one paisa more', () => {
  assert.equal(parseAmount('1000000000'), MAX_PAISE);
  assert.equal(parseAmount('1000000000.00'), MAX_PAISE);
  assert.equal(parseAmount('-1000000000'), -MAX_PAISE);
  assert.throws(() => parseAmount('1000000000.01'), RangeError);
  assert.throws(() => parseAmount('-1000000000.01'), RangeError);
});

test('parseAmount: the number overload matches the string path', () => {
  for (let paise = -250000; paise <= 250000; paise += 37) {
    if (paise === 0) continue; // covered separately; avoids the -0 formatting edge
    const asNumber = paise / 100;
    const asText = asNumber.toFixed(2);
    assert.equal(parseAmount(asText), paise, `parseAmount(${JSON.stringify(asText)})`);
    assert.equal(parseAmount(asNumber), paise, `parseAmount(${asNumber})`);
    assert.equal(parseAmount(asNumber), parseAmount(asText));
  }
  assert.equal(parseAmount(0), 0);
  assert.equal(parseAmount('0'), 0);
});

test('parseAmount: number overload rounds to two decimals like toFixed', () => {
  assert.equal(parseAmount(12.345), parseAmount((12.345).toFixed(2)));
  assert.equal(parseAmount(7), 700);
  assert.equal(parseAmount(-7.5), -750);
  assert.equal(parseAmount(0.01), 1);
});

test('parseAmount: round-trips through formatPaise and formatINR', () => {
  const rng = makeRng(0x5f11 | 1);
  const samples = [0, 1, 99, 100, 12345, 999999, 100000000, MAX_PAISE];
  for (let i = 0; i < 200; i++) {
    samples.push(Math.floor(rng() * 1e10));
  }
  for (const paise of samples) {
    assert.equal(parseAmount(formatPaise(paise)), paise, `formatPaise(${paise})`);
    assert.equal(parseAmount(formatINR(paise)), paise, `formatINR(${paise})`);
    if (paise !== 0) {
      assert.equal(parseAmount(formatPaise(-paise)), -paise, `formatPaise(${-paise})`);
      assert.equal(parseAmount(formatINR(-paise)), -paise, `formatINR(${-paise})`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * parseAmount — rejected input (always a RangeError)
 * ------------------------------------------------------------------ */

test('parseAmount: every rejection is a RangeError', () => {
  const rejected = [
    '',
    '   ',
    '₹',
    ',',
    'abc',
    '12abc',
    'abc12',
    '1.234',
    '0.001',
    '1.2.3',
    '1..2',
    '12e5',
    '1e3',
    '1E3',
    '--5',
    '5-',
    '+-5',
    '12.-3',
    '1,2,3.456',
    'NaN',
    'Infinity',
    '0x10',
    '½',
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    true,
    false,
    {},
    [],
    ['12'],
    () => 12,
    1e21, // toFixed(2) yields exponential notation, which is not digits
    2000000000, // rupees above the cap
    1e10,
    '99999999999999999999', // blows past the safe-integer guard
    '2000000000',
  ];
  for (const input of rejected) {
    assert.throws(
      () => parseAmount(input),
      RangeError,
      `expected RangeError for ${typeof input} ${String(input)}`,
    );
  }
});

test('parseAmount: rejection messages are human readable', () => {
  assert.throws(() => parseAmount(''), { name: 'RangeError', message: /amount/i });
  assert.throws(() => parseAmount('1.234'), { name: 'RangeError', message: /decimal/i });
  assert.throws(() => parseAmount('1.2.3'), { name: 'RangeError', message: /decimal point/i });
  assert.throws(() => parseAmount('2000000000'), { name: 'RangeError', message: /too large/i });
});

/* ------------------------------------------------------------------ *
 * formatPaise / formatINR
 * ------------------------------------------------------------------ */

test('formatPaise: Indian grouping at 3 through 9 rupee digits', () => {
  const cases = [
    [100, '100.00'], // 3 digits
    [1000, '1,000.00'], // 4 digits
    [10000, '10,000.00'], // 5 digits
    [100000, '1,00,000.00'], // 6 digits
    [1000000, '10,00,000.00'], // 7 digits
    [10000000, '1,00,00,000.00'], // 8 digits
    [100000000, '10,00,00,000.00'], // 9 digits
  ];
  for (const [rupees, expected] of cases) {
    assert.equal(formatPaise(rupees * 100), expected, `${rupees} rupees`);
    assert.equal(formatINR(rupees * 100), `₹${expected}`, `${rupees} rupees with symbol`);
  }
});

test('formatPaise: small magnitudes are ungrouped', () => {
  assert.equal(formatPaise(0), '0.00');
  assert.equal(formatPaise(1), '0.01');
  assert.equal(formatPaise(5), '0.05');
  assert.equal(formatPaise(50), '0.50');
  assert.equal(formatPaise(99), '0.99');
  assert.equal(formatPaise(100), '1.00');
  assert.equal(formatPaise(123456), '1,234.56');
  assert.equal(formatPaise(99999), '999.99');
});

test('formatPaise: grouping is correct across random magnitudes', () => {
  const rng = makeRng(20260911);
  for (let i = 0; i < 600; i++) {
    const digits = 1 + Math.floor(rng() * 13); // 1..13 rupee digits
    let rupees = 0;
    for (let d = 0; d < digits; d++) rupees = rupees * 10 + Math.floor(rng() * 10);
    const paisePart = Math.floor(rng() * 100);
    const paise = rupees * 100 + paisePart;
    assert.ok(Number.isSafeInteger(paise));

    for (const negative of [false, true]) {
      const value = negative ? -paise : paise;
      const text = formatPaise(value, { symbol: true });
      assert.doesNotMatch(text, /e/i, `"${text}" must never use exponential notation`);

      const { prefix, body } = splitFormatted(text);
      assert.equal(prefix, negative && paise !== 0 ? '-₹' : '₹');

      const [grouped, frac] = body.split('.');
      assert.equal(body.split('.').length, 2, `"${body}" must have exactly one decimal point`);
      assert.equal(frac, String(paisePart).padStart(2, '0'));
      assert.equal(grouped.replace(/,/g, ''), String(rupees));
      assertIndianGrouping(grouped);
    }
  }
});

test('formatPaise: the paise part is always two digits', () => {
  for (let paise = 0; paise <= 1000; paise++) {
    const [, frac] = formatPaise(paise).split('.');
    assert.equal(frac.length, 2, `paise=${paise}`);
    assert.equal(Number(frac), paise % 100);
  }
});

test('formatPaise: the minus sign comes before the rupee symbol', () => {
  assert.equal(formatINR(-123456), '-₹1,234.56');
  assert.equal(formatPaise(-123456, { symbol: true }), '-₹1,234.56');
  assert.equal(formatPaise(-123456), '-1,234.56');
  assert.equal(formatPaise(-5, { symbol: true }), '-₹0.05');
  assert.equal(formatINR(-15000000, { compact: true }), '-₹1.5L');
  for (const paise of [-1, -99, -100, -100000, -MAX_PAISE]) {
    assert.ok(formatINR(paise).startsWith('-₹'), `${paise} -> ${formatINR(paise)}`);
  }
});

test('formatPaise: sign option adds + only for strictly positive values', () => {
  assert.equal(formatPaise(0, { sign: true }), '0.00');
  assert.equal(formatPaise(0, { sign: true, symbol: true }), '₹0.00');
  assert.equal(formatPaise(1, { sign: true }), '+0.01');
  assert.equal(formatPaise(1, { sign: true, symbol: true }), '+₹0.01');
  assert.equal(formatPaise(-1, { sign: true, symbol: true }), '-₹0.01');
  assert.equal(formatPaise(123456, { sign: true }), '+1,234.56');

  for (const paise of [-100000, -101, -1, 0, 1, 101, 100000]) {
    const text = formatPaise(paise, { sign: true });
    if (paise > 0) assert.ok(text.startsWith('+'), `${paise} -> ${text}`);
    else assert.ok(!text.startsWith('+'), `${paise} -> ${text}`);
    if (paise < 0) assert.ok(text.startsWith('-'), `${paise} -> ${text}`);
  }
});

test('formatPaise: sign option is off by default', () => {
  assert.equal(formatPaise(123456), '1,234.56');
  assert.equal(formatPaise(123456, {}), '1,234.56');
});

test('formatPaise: fractional input is truncated toward zero', () => {
  assert.equal(formatPaise(12.7), '0.12');
  assert.equal(formatPaise(-12.7), '-0.12');
  assert.equal(formatPaise(99.999), '0.99');
});

test('formatINR: always adds the symbol and forwards other options', () => {
  assert.equal(formatINR(123456), '₹1,234.56');
  assert.equal(formatINR(123456, { sign: true }), '+₹1,234.56');
  assert.equal(formatINR(0), '₹0.00');
  // formatINR forces symbol:true — an explicit false cannot switch it off.
  assert.equal(formatINR(123456, { symbol: false }), '₹1,234.56');
  for (const paise of [0, 1, 12345, 123456789]) {
    assert.equal(formatINR(paise), formatPaise(paise, { symbol: true }));
    assert.equal(formatINR(paise, { sign: true }), formatPaise(paise, { symbol: true, sign: true }));
  }
});

/* ------------------------------------------------------------------ *
 * formatPaise — compact mode
 * ------------------------------------------------------------------ */

test('formatPaise: compact switches to L at one lakh rupees', () => {
  const oneLakh = 100000 * 100; // 1,00,000 rupees in paise
  assert.equal(formatPaise(oneLakh - 1, { compact: true }), '99,999.99');
  assert.equal(formatPaise(oneLakh, { compact: true }), '1L');
  assert.equal(formatPaise(oneLakh + 100, { compact: true }), '1L');
  assert.equal(formatPaise(150000 * 100, { compact: true }), '1.5L');
  assert.equal(formatPaise(123456 * 100, { compact: true }), '1.23L');
  assert.equal(formatINR(150000 * 100, { compact: true }), '₹1.5L');
});

test('formatPaise: compact switches to Cr at one crore rupees', () => {
  const oneCrore = 10000000 * 100; // 1,00,00,000 rupees in paise
  assert.equal(formatPaise(oneCrore, { compact: true }), '1Cr');
  assert.equal(formatPaise(oneCrore * 1.2345, { compact: true }), '1.23Cr');
  assert.equal(formatPaise(oneCrore * 25, { compact: true }), '25Cr');
  assert.equal(formatINR(oneCrore, { compact: true }), '₹1Cr');
  assert.ok(formatPaise(oneCrore - 100, { compact: true }).endsWith('L'));
});

test('formatPaise: compact picks the right unit across the whole range', () => {
  const oneLakh = 100000 * 100;
  const oneCrore = 10000000 * 100;
  const rng = makeRng(7654321);
  for (let i = 0; i < 300; i++) {
    const paise = Math.floor(rng() * MAX_PAISE);
    const text = formatPaise(paise, { compact: true });
    if (paise >= oneCrore) assert.ok(text.endsWith('Cr'), `${paise} -> ${text}`);
    else if (paise >= oneLakh) assert.ok(text.endsWith('L'), `${paise} -> ${text}`);
    else assert.match(text, /^[\d,]+\.\d{2}$/, `${paise} -> ${text}`);
    assert.doesNotMatch(text, /e\+/i);
  }
});

test('formatPaise: compact keeps sign handling and trims trailing zeros', () => {
  const oneCrore = 10000000 * 100;
  assert.equal(formatPaise(-oneCrore, { compact: true, symbol: true }), '-₹1Cr');
  assert.equal(formatPaise(oneCrore, { compact: true, sign: true, symbol: true }), '+₹1Cr');
  assert.equal(formatPaise(oneCrore * 2, { compact: true }), '2Cr');
  assert.equal(formatPaise(oneCrore * 2.5, { compact: true }), '2.5Cr');
  assert.equal(formatPaise(oneCrore * 10, { compact: true }), '10Cr');
});

test('formatPaise: compact is off unless asked for', () => {
  assert.equal(formatPaise(10000000), '1,00,000.00');
  assert.equal(formatPaise(10000000, { compact: false }), '1,00,000.00');
});

/* ------------------------------------------------------------------ *
 * splitEvenly
 * ------------------------------------------------------------------ */

test('splitEvenly: worked examples', () => {
  assert.deepEqual(splitEvenly(10, 3), [4, 3, 3]);
  assert.deepEqual(splitEvenly(100, 3), [34, 33, 33]);
  assert.deepEqual(splitEvenly(100, 4), [25, 25, 25, 25]);
  assert.deepEqual(splitEvenly(1, 3), [1, 0, 0]);
  assert.deepEqual(splitEvenly(2, 3), [1, 1, 0]);
  assert.deepEqual(splitEvenly(0, 3), [0, 0, 0]);
  assert.deepEqual(splitEvenly(7, 1), [7]);
  assert.deepEqual(noNegZero(splitEvenly(-1, 3)), [-1, 0, 0]);
  assert.deepEqual(splitEvenly(-10, 3), [-4, -3, -3]);
  assert.deepEqual(splitEvenly(-100, 3), [-34, -33, -33]);
});

test('splitEvenly: sums exactly for totals 0..200 across n 1..12', () => {
  for (let magnitude = 0; magnitude <= 200; magnitude++) {
    for (const total of magnitude === 0 ? [0] : [magnitude, -magnitude]) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEvenly(total, n);
        assert.equal(parts.length, n, `length for total=${total} n=${n}`);
        for (const part of parts) {
          assert.ok(Number.isInteger(part), `non-integer part for total=${total} n=${n}`);
        }
        assert.equal(sum(parts), total, `sum for total=${total} n=${n}`);
      }
    }
  }
});

test('splitEvenly: the remainder always goes to the earliest entries', () => {
  for (let magnitude = 0; magnitude <= 200; magnitude++) {
    for (const total of magnitude === 0 ? [0] : [magnitude, -magnitude]) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEvenly(total, n);
        const base = Math.floor(magnitude / n);
        const remainder = magnitude - base * n;

        for (let i = 0; i < n; i++) {
          const expected = base + (i < remainder ? 1 : 0);
          assert.equal(
            Math.abs(parts[i]),
            expected,
            `total=${total} n=${n} index=${i} -> ${parts[i]}`,
          );
        }
        // Magnitudes are non-increasing and differ by at most one paisa.
        for (let i = 1; i < n; i++) {
          const prev = Math.abs(parts[i - 1]);
          const cur = Math.abs(parts[i]);
          assert.ok(prev >= cur, `not front-loaded: total=${total} n=${n}`);
          assert.ok(prev - cur <= 1, `spread > 1 paisa: total=${total} n=${n}`);
        }
      }
    }
  }
});

test('splitEvenly: every part carries the sign of the total', () => {
  for (const total of [-9999, -1, 0, 1, 9999]) {
    for (let n = 1; n <= 12; n++) {
      for (const part of splitEvenly(total, n)) {
        if (total > 0) assert.ok(part >= 0);
        if (total < 0) assert.ok(part <= 0);
        if (total === 0) assert.equal(part, 0);
      }
    }
  }
});

test('splitEvenly: sums exactly for large random totals and party sizes', () => {
  const rng = makeRng(13579);
  for (let i = 0; i < 500; i++) {
    const total = Math.floor(rng() * 2e9) - 1e9;
    const n = 1 + Math.floor(rng() * 64);
    const parts = splitEvenly(total, n);
    assert.equal(parts.length, n);
    assert.equal(sum(parts), total, `total=${total} n=${n}`);
  }
});

test('splitEvenly: rejects invalid participant counts and totals', () => {
  for (const n of [0, -1, -12, 1.5, 0.5, NaN, Infinity, -Infinity, '3', null, undefined, [3]]) {
    assert.throws(() => splitEvenly(1000, n), RangeError, `n=${String(n)}`);
  }
  for (const total of [1.5, NaN, Infinity, -Infinity, '100', null, undefined]) {
    assert.throws(() => splitEvenly(total, 3), RangeError, `total=${String(total)}`);
  }
});

/* ------------------------------------------------------------------ *
 * allocateByWeights
 * ------------------------------------------------------------------ */

/** Weight vectors exercised by the allocation property loop. */
const WEIGHT_VECTORS = [
  [1],
  [7],
  [1, 1],
  [1, 0],
  [0, 1],
  [1, 1, 1],
  [1, 2, 3],
  [1, 0, 1],
  [0, 0, 5],
  [5, 0, 0],
  [1, 1, 1, 1],
  [3, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  [1000000, 1],
  [1, 1000000],
  [1, 2, 4, 8, 16, 32, 64],
  [0.5, 0.25, 0.25],
  [2.5, 7.5],
  [0, 0, 0, 1, 0, 0],
  [9, 1, 0, 0, 0, 0, 0, 0],
];

/** Totals exercised by the allocation property loop (both signs). */
const ALLOCATION_TOTALS = [
  0, 1, 2, 3, 5, 7, 11, 99, 100, 101, 333, 999, 1000, 1001, 1234, 5000, 99999, 100000, 123456789,
];

test('allocateByWeights: sums exactly across the whole matrix', () => {
  for (const magnitude of ALLOCATION_TOTALS) {
    for (const total of magnitude === 0 ? [0] : [magnitude, -magnitude]) {
      for (const weights of WEIGHT_VECTORS) {
        const label = `total=${total} weights=[${weights}]`;
        const parts = allocateByWeights(total, weights);

        assert.equal(parts.length, weights.length, `length: ${label}`);
        for (const part of parts) {
          assert.ok(Number.isInteger(part), `non-integer: ${label}`);
        }
        assert.equal(sum(parts), total, `sum: ${label}`);

        for (let i = 0; i < weights.length; i++) {
          if (weights[i] === 0) {
            assert.equal(Math.abs(parts[i]), 0, `zero weight got paise: ${label} index=${i}`);
          }
          if (total > 0) assert.ok(parts[i] >= 0, `negative share: ${label}`);
          if (total < 0) assert.ok(parts[i] <= 0, `positive share: ${label}`);
          if (total === 0) assert.equal(parts[i], 0, `non-zero share of zero: ${label}`);
          assert.ok(Math.abs(parts[i]) <= Math.abs(total), `share exceeds total: ${label}`);
        }

        // A heavier weight can never receive less than a lighter one.
        for (let i = 0; i < weights.length; i++) {
          for (let j = 0; j < weights.length; j++) {
            if (weights[i] > weights[j]) {
              assert.ok(
                Math.abs(parts[i]) >= Math.abs(parts[j]),
                `not weight-monotonic: ${label} (${i} vs ${j})`,
              );
            }
          }
        }
      }
    }
  }
});

test('allocateByWeights: largest-remainder behaviour for the classic thirds case', () => {
  assert.deepEqual(allocateByWeights(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateByWeights(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(allocateByWeights(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocateByWeights(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(noNegZero(allocateByWeights(-100, [1, 1, 1])), [-34, -33, -33]);
});

test('allocateByWeights: ties are broken by the lowest index', () => {
  assert.deepEqual(allocateByWeights(1, [1, 1]), [1, 0]);
  assert.deepEqual(allocateByWeights(1, [5, 5, 5]), [1, 0, 0]);
  assert.deepEqual(allocateByWeights(3, [1, 1]), [2, 1]);
  assert.deepEqual(allocateByWeights(1000, [1, 1, 1, 1, 1, 1]), [167, 167, 167, 167, 166, 166]);
});

test('allocateByWeights: zero weights receive nothing', () => {
  assert.deepEqual(allocateByWeights(101, [1, 0, 1]), [51, 0, 50]);
  assert.deepEqual(allocateByWeights(7777, [0, 3, 0]), [0, 7777, 0]);
  assert.deepEqual(allocateByWeights(99, [0, 0, 0, 0, 1]), [0, 0, 0, 0, 99]);
});

test('allocateByWeights: a single non-zero weight takes the whole total', () => {
  for (const total of [0, 1, 99, 100000, -12345]) {
    for (let idx = 0; idx < 4; idx++) {
      const weights = [0, 0, 0, 0];
      weights[idx] = 3;
      const parts = allocateByWeights(total, weights);
      assert.equal(parts[idx], total, `total=${total} idx=${idx}`);
      assert.equal(sum(parts), total);
      for (let i = 0; i < parts.length; i++) {
        if (i !== idx) assert.equal(Math.abs(parts[i]), 0);
      }
    }
  }
});

test('allocateByWeights: highly skewed weights still sum exactly', () => {
  assert.deepEqual(allocateByWeights(1, [1, 1000000]), [0, 1]);
  assert.deepEqual(allocateByWeights(1, [1000000, 1]), [1, 0]);
  const skewed = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1000000];
  for (const total of [1, 2, 9, 10, 11, 100, 100000]) {
    const parts = allocateByWeights(total, skewed);
    assert.equal(sum(parts), total, `total=${total}`);
    assert.ok(parts[9] >= parts[0], 'the dominant weight takes the lion share');
  }
});

test('allocateByWeights: fractional and proportional weights', () => {
  assert.deepEqual(allocateByWeights(100, [0.5, 0.25, 0.25]), [50, 25, 25]);
  assert.deepEqual(allocateByWeights(100, [2.5, 7.5]), [25, 75]);
  assert.deepEqual(allocateByWeights(100, [50, 30, 20]), [50, 30, 20]);
  assert.deepEqual(allocateByWeights(100, [1, 3]), [25, 75]);
});

test('allocateByWeights: equal weights agree with splitEvenly', () => {
  for (let magnitude = 0; magnitude <= 200; magnitude++) {
    for (const total of magnitude === 0 ? [0] : [magnitude, -magnitude]) {
      for (let n = 1; n <= 12; n++) {
        const weights = new Array(n).fill(1);
        assert.deepEqual(
          noNegZero(allocateByWeights(total, weights)),
          noNegZero(splitEvenly(total, n)),
          `total=${total} n=${n}`,
        );
      }
    }
  }
});

test('allocateByWeights: sums exactly for random totals and weight vectors', () => {
  const rng = makeRng(2468101);
  for (let i = 0; i < 500; i++) {
    const n = 1 + Math.floor(rng() * 10);
    const weights = [];
    let nonZero = 0;
    for (let k = 0; k < n; k++) {
      const w = rng() < 0.25 ? 0 : Math.floor(rng() * 50);
      weights.push(w);
      if (w > 0) nonZero++;
    }
    if (nonZero === 0) weights[0] = 1;
    const total = Math.floor(rng() * 4000000) - 2000000;
    const parts = allocateByWeights(total, weights);
    assert.equal(parts.length, weights.length);
    assert.equal(sum(parts), total, `total=${total} weights=[${weights}]`);
    for (let k = 0; k < weights.length; k++) {
      if (weights[k] === 0) assert.equal(Math.abs(parts[k]), 0, `weights=[${weights}]`);
    }
  }
});

test('allocateByWeights: rejects unusable weights', () => {
  assert.throws(() => allocateByWeights(100, [0, 0, 0]), RangeError);
  assert.throws(() => allocateByWeights(100, [0]), RangeError);
  assert.throws(() => allocateByWeights(100, [1, -1]), RangeError);
  assert.throws(() => allocateByWeights(100, [-1]), RangeError);
  assert.throws(() => allocateByWeights(100, [1, -0.5, 2]), RangeError);
  assert.throws(() => allocateByWeights(100, []), RangeError);
  assert.throws(() => allocateByWeights(100, [1, NaN]), RangeError);
  assert.throws(() => allocateByWeights(100, [1, Infinity]), RangeError);
  assert.throws(() => allocateByWeights(100, [1, '2']), RangeError);
  assert.throws(() => allocateByWeights(100, [1, null]), RangeError);
  assert.throws(() => allocateByWeights(100, [1, undefined]), RangeError);
  assert.throws(() => allocateByWeights(100, null), RangeError);
  assert.throws(() => allocateByWeights(100, undefined), RangeError);
  assert.throws(() => allocateByWeights(100, 'abc'), RangeError);
  assert.throws(() => allocateByWeights(100, { 0: 1, length: 1 }), RangeError);
});

test('allocateByWeights: rejects non-integer totals', () => {
  for (const total of [1.5, NaN, Infinity, -Infinity, '100', null, undefined]) {
    assert.throws(() => allocateByWeights(total, [1, 1]), RangeError, `total=${String(total)}`);
  }
});

/* ------------------------------------------------------------------ *
 * sum
 * ------------------------------------------------------------------ */

test('sum: adds integer paise', () => {
  assert.equal(sum([]), 0);
  assert.equal(sum([0]), 0);
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([-1, -2, -3]), -6);
  assert.equal(sum([100, -100]), 0);
  assert.equal(sum([12345, 67890, -12345]), 67890);
});

test('sum: rejects non-integer members', () => {
  for (const bad of [1.5, 0.1, NaN, Infinity, -Infinity, '1', null, undefined, true, [1], {}]) {
    assert.throws(() => sum([1, bad, 2]), RangeError, `value=${String(bad)}`);
  }
});

test('sum: guards the safe-integer range', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(sum([max - 1, 1]), max);
  assert.equal(sum([-(max - 1), -1]), -max);
  assert.throws(() => sum([max, 1]), RangeError);
  assert.throws(() => sum([max, max]), RangeError);
  assert.throws(() => sum([-max, -max]), RangeError);
  assert.throws(() => sum([max, max, -max]), RangeError, 'the guard is on the running total');
});

test('sum: agrees with the split and allocation invariants', () => {
  for (let total = -50; total <= 50; total++) {
    for (let n = 1; n <= 8; n++) {
      assert.equal(sum(splitEvenly(total, n)), total);
      assert.equal(sum(allocateByWeights(total, new Array(n).fill(2))), total);
    }
  }
});

/* ------------------------------------------------------------------ *
 * paiseToUpiAmount
 * ------------------------------------------------------------------ */

test('paiseToUpiAmount: exactly two decimals, no grouping, no exponent', () => {
  const cases = [
    [0, '0.00'],
    [1, '0.01'],
    [99, '0.99'],
    [100, '1.00'],
    [1250, '12.50'],
    [100000, '1000.00'],
    [MAX_PAISE, '1000000000.00'],
    [999999999999999, '9999999999999.99'],
  ];
  for (const [paise, expected] of cases) {
    assert.equal(paiseToUpiAmount(paise), expected, `paise=${paise}`);
  }
});

test('paiseToUpiAmount: output always matches the UPI am= grammar', () => {
  const rng = makeRng(99887766);
  const samples = [0, 1, 99, 100, 1250, 100000, MAX_PAISE, 999999999999999];
  for (let i = 0; i < 400; i++) samples.push(Math.floor(rng() * MAX_PAISE));
  for (const paise of samples) {
    const text = paiseToUpiAmount(paise);
    assert.match(text, /^\d+\.\d{2}$/, `paise=${paise} -> ${text}`);
    assert.doesNotMatch(text, /[,e+]/i, `paise=${paise} -> ${text}`);
    const [rupees, frac] = text.split('.');
    assert.equal(Number(rupees), Math.floor(paise / 100));
    assert.equal(Number(frac), paise % 100);
  }
});

test('paiseToUpiAmount: serialises the magnitude and truncates fractions', () => {
  assert.equal(paiseToUpiAmount(-1250), '12.50');
  assert.equal(paiseToUpiAmount(-1), '0.01');
  assert.equal(paiseToUpiAmount(1250.9), '12.50');
  assert.equal(paiseToUpiAmount(-0), '0.00');
});

/* ------------------------------------------------------------------ *
 * clamp, rupeesToPaise, paiseToRupees
 * ------------------------------------------------------------------ */

test('clamp: keeps values inside the closed range', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(0, 1, 10), 1);
  assert.equal(clamp(11, 1, 10), 10);
  assert.equal(clamp(1, 1, 10), 1, 'the lower bound is inclusive');
  assert.equal(clamp(10, 1, 10), 10, 'the upper bound is inclusive');
  assert.equal(clamp(-5, -10, -1), -5);
  assert.equal(clamp(-50, -10, -1), -10);
  assert.equal(clamp(0.5, 0, 1), 0.5, 'clamp is not restricted to integers');
});

test('clamp: property — result is in range and only changes out-of-range input', () => {
  for (let lo = -5; lo <= 5; lo++) {
    for (let hi = lo; hi <= lo + 10; hi++) {
      for (let n = lo - 6; n <= hi + 6; n++) {
        const out = clamp(n, lo, hi);
        assert.ok(out >= lo && out <= hi, `clamp(${n}, ${lo}, ${hi}) = ${out}`);
        if (n < lo) assert.equal(out, lo);
        else if (n > hi) assert.equal(out, hi);
        else assert.equal(out, n);
      }
    }
  }
});

test('rupeesToPaise: rounds a rupee float to the nearest paisa', () => {
  assert.equal(rupeesToPaise(0), 0);
  assert.equal(rupeesToPaise(1), 100);
  assert.equal(rupeesToPaise(12.34), 1234);
  assert.equal(rupeesToPaise(-12.34), -1234);
  assert.equal(rupeesToPaise(0.1), 10);
  assert.equal(rupeesToPaise(1234.56), 123456);
  // Math.round breaks ties toward +Infinity.
  assert.equal(rupeesToPaise(0.125), 13);
  assert.equal(rupeesToPaise(-0.125), -12);
});

test('paiseToRupees: divides by 100', () => {
  assert.equal(paiseToRupees(0), 0);
  assert.equal(paiseToRupees(1), 0.01);
  assert.equal(paiseToRupees(100), 1);
  assert.equal(paiseToRupees(12345), 123.45);
  assert.equal(paiseToRupees(-5025), -50.25);
});

test('rupeesToPaise and paiseToRupees round-trip', () => {
  const rng = makeRng(314159);
  const samples = [0, 1, 5, 99, 100, 101, 12345, 999999, 100000000];
  for (let i = 0; i < 400; i++) samples.push(Math.floor(rng() * 1e9));
  for (const paise of samples) {
    assert.equal(rupeesToPaise(paiseToRupees(paise)), paise, `paise=${paise}`);
    if (paise !== 0) {
      assert.equal(rupeesToPaise(paiseToRupees(-paise)), -paise, `paise=${-paise}`);
    }
  }
});

test('paiseToRupees feeds paiseToUpiAmount consistently', () => {
  for (const paise of [0, 1, 99, 100, 1250, 100000, 123456789]) {
    assert.equal(Number(paiseToUpiAmount(paise)), paiseToRupees(paise));
  }
});
