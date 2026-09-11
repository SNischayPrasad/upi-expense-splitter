import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPLIT_TYPES, computeShares, describeSplit, validateSplit } from '../src/core/split.js';
import { splitEvenly, sum } from '../src/core/money.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Totals chosen to exercise indivisible remainders and large values. */
const TOTALS = [1, 2, 3, 7, 100, 99999, 1234567];
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** `ids(3)` -> ['m1', 'm2', 'm3'] */
function ids(n) {
  return Array.from({ length: n }, (_, i) => `m${i + 1}`);
}

function totalOf(shares) {
  return sum(shares.map((s) => s.paise));
}

function shareFor(shares, memberId) {
  const hit = shares.find((s) => s.memberId === memberId);
  assert.ok(hit, `no share for ${memberId}`);
  return hit.paise;
}

function equalExpense(amount, n) {
  return { amount, splitType: 'equal', participants: ids(n), splitData: {} };
}

function exactExpense(amount, n) {
  const participants = ids(n);
  const parts = splitEvenly(amount, n);
  const splitData = {};
  participants.forEach((id, i) => {
    splitData[id] = parts[i];
  });
  return { amount, splitType: 'exact', participants, splitData };
}

/** Percentages derived from weights 1..n, with the last one absorbing the rounding. */
function percentExpense(amount, n) {
  const participants = ids(n);
  const weights = participants.map((_, i) => i + 1);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const splitData = {};
  let assigned = 0;
  for (let i = 0; i < n - 1; i++) {
    const pct = Math.round((weights[i] / weightTotal) * 10000) / 100;
    splitData[participants[i]] = pct;
    assigned += pct;
  }
  splitData[participants[n - 1]] = Math.round((100 - assigned) * 100) / 100;
  return { amount, splitType: 'percent', participants, splitData };
}

function sharesExpense(amount, n, { zeroFirst = false } = {}) {
  const participants = ids(n);
  const splitData = {};
  participants.forEach((id, i) => {
    splitData[id] = zeroFirst && i === 0 ? 0 : i + 1;
  });
  return { amount, splitType: 'shares', participants, splitData };
}

/** Adjustments that always total exactly floor(amount / 2), so they never exceed the bill. */
function adjustmentExpense(amount, n) {
  const participants = ids(n);
  const splitData = {};
  let others = 0;
  for (let i = 1; i < n; i++) {
    const value = (i % 2 === 1 ? 1 : -1) * ((i * 37) % 101);
    splitData[participants[i]] = value;
    others += value;
  }
  splitData[participants[0]] = Math.floor(amount / 2) - others;
  return { amount, splitType: 'adjustment', participants, splitData };
}

/** Three items plus tax/tip/discount that reconcile to `amount` exactly. */
function itemisedExpense(amount, n) {
  const participants = ids(n);
  const tax = Math.floor(amount * 0.05);
  const tip = Math.floor(amount * 0.1);
  const discount = Math.floor(amount * 0.03);
  const itemsTotal = amount - tax - tip + discount;
  const amounts = splitEvenly(itemsTotal, 3);
  const items = [
    { id: 'i1', name: 'Starters', amount: amounts[0], participants: participants.slice() },
    {
      id: 'i2',
      name: 'Mains',
      amount: amounts[1],
      participants: participants.slice(0, Math.max(1, Math.ceil(n / 2))),
    },
    { id: 'i3', name: 'Drinks', amount: amounts[2], participants: [participants[n - 1]] },
  ];
  return { amount, splitType: 'itemized', participants, splitData: { items, tax, tip, discount } };
}

const BUILDERS = {
  equal: equalExpense,
  exact: exactExpense,
  percent: percentExpense,
  shares: sharesExpense,
  adjustment: adjustmentExpense,
  itemized: itemisedExpense,
};

/* ------------------------------------------------------------------ *
 * Contract surface
 * ------------------------------------------------------------------ */

test('SPLIT_TYPES lists exactly the six strategies', () => {
  assert.deepEqual(SPLIT_TYPES, ['equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized']);
});

test('every split type has a fixture builder', () => {
  assert.deepEqual(Object.keys(BUILDERS).sort(), [...SPLIT_TYPES].sort());
});

/* ------------------------------------------------------------------ *
 * Property: shares always sum EXACTLY to the total
 * ------------------------------------------------------------------ */

for (const splitType of SPLIT_TYPES) {
  test(`${splitType}: shares sum exactly to the total for every total x party size`, () => {
    for (const amount of TOTALS) {
      for (const n of COUNTS) {
        const expense = BUILDERS[splitType](amount, n);
        const where = `${splitType} @ ${amount} paise across ${n}`;

        const check = validateSplit(expense);
        assert.equal(check.ok, true, `${where} should validate, got: ${check.error}`);

        const shares = computeShares(expense);
        assert.equal(shares.length, n, `${where}: one share per participant`);
        assert.deepEqual(
          shares.map((s) => s.memberId),
          expense.participants,
          `${where}: shares follow participant order`
        );
        for (const share of shares) {
          assert.ok(Number.isInteger(share.paise), `${where}: ${share.memberId} got a non-integer`);
        }
        assert.equal(totalOf(shares), amount, `${where}: must reconcile`);
      }
    }
  });
}

test('shares: a member with a weight of zero pays nothing and the rest still reconcile', () => {
  for (const amount of TOTALS) {
    for (const n of COUNTS.filter((c) => c >= 2)) {
      const expense = sharesExpense(amount, n, { zeroFirst: true });
      const shares = computeShares(expense);
      assert.equal(shareFor(shares, 'm1'), 0, `zero-weight member @ ${amount}/${n}`);
      assert.equal(totalOf(shares), amount);
    }
  }
});

test('equal: a refund (negative total) also reconciles exactly', () => {
  const shares = computeShares(equalExpense(-10000, 3));
  assert.equal(totalOf(shares), -10000);
  assert.deepEqual(
    shares.map((s) => s.paise),
    [-3334, -3333, -3333]
  );
});

/* ------------------------------------------------------------------ *
 * The classic rounding cases
 * ------------------------------------------------------------------ */

test('₹100 split equally 3 ways is [3334, 3333, 3333]', () => {
  const shares = computeShares(equalExpense(10000, 3));
  assert.deepEqual(
    shares.map((s) => s.paise),
    [3334, 3333, 3333]
  );
  assert.equal(totalOf(shares), 10000);
});

test('₹0.01 split equally 5 ways still sums to 1 paisa', () => {
  const shares = computeShares(equalExpense(1, 5));
  assert.deepEqual(
    shares.map((s) => s.paise),
    [1, 0, 0, 0, 0]
  );
  assert.equal(totalOf(shares), 1);
});

test('percent 33.33 / 33.33 / 33.34 on ₹1000 sums exactly and keeps integers', () => {
  const participants = ids(3);
  const expense = {
    amount: 100000,
    splitType: 'percent',
    participants,
    splitData: { m1: 33.33, m2: 33.33, m3: 33.34 },
  };
  assert.equal(validateSplit(expense).ok, true);

  const shares = computeShares(expense);
  assert.equal(totalOf(shares), 100000);
  for (const share of shares) assert.ok(Number.isInteger(share.paise));
  assert.equal(shareFor(shares, 'm1'), shareFor(shares, 'm2'));
  assert.equal(shareFor(shares, 'm3') - shareFor(shares, 'm1'), 10);
});

test('percent tolerates a floating-point sum of 100.00000000000001', () => {
  const third = 100 / 3;
  const expense = {
    amount: 100000,
    splitType: 'percent',
    participants: ids(3),
    splitData: { m1: third, m2: third, m3: third },
  };
  assert.equal(validateSplit(expense).ok, true);
  assert.equal(totalOf(computeShares(expense)), 100000);
});

/* ------------------------------------------------------------------ *
 * Adjustment
 * ------------------------------------------------------------------ */

test('adjustment: +₹150 on a ₹600 bill for 3 means that person pays ₹300', () => {
  const expense = {
    amount: 60000,
    splitType: 'adjustment',
    participants: ids(3),
    splitData: { m1: 15000 },
  };
  assert.equal(validateSplit(expense).ok, true);

  const shares = computeShares(expense);
  assert.equal(shareFor(shares, 'm1'), 30000);
  assert.equal(shareFor(shares, 'm2'), 15000);
  assert.equal(shareFor(shares, 'm3'), 15000);
  assert.equal(totalOf(shares), 60000);
});

test('adjustment: a negative adjustment reduces one share and reconciles', () => {
  const expense = {
    amount: 30000,
    splitType: 'adjustment',
    participants: ids(3),
    splitData: { m2: -3000 },
  };
  const shares = computeShares(expense);
  assert.equal(shareFor(shares, 'm2'), 8000);
  assert.equal(shareFor(shares, 'm1'), 11000);
  assert.equal(shareFor(shares, 'm3'), 11000);
  assert.equal(totalOf(shares), 30000);
});

test('adjustment: a missing entry simply means no adjustment', () => {
  const expense = { amount: 90000, splitType: 'adjustment', participants: ids(3) };
  assert.equal(validateSplit(expense).ok, true);
  assert.deepEqual(
    computeShares(expense).map((s) => s.paise),
    [30000, 30000, 30000]
  );
});

/* ------------------------------------------------------------------ *
 * Itemised
 * ------------------------------------------------------------------ */

test('itemised: a restaurant bill with tax, tip and discount reconciles exactly', () => {
  // Paneer ₹450 (all three), Biryani ₹620 (m1, m2), Lassi ₹180 (m3).
  // Subtotal ₹1250 + tax ₹62.50 + tip ₹100 - discount ₹50 = ₹1362.50.
  const expense = {
    amount: 136250,
    splitType: 'itemized',
    participants: ids(3),
    splitData: {
      items: [
        { id: 'i1', name: 'Paneer Tikka', amount: 45000, participants: ['m1', 'm2', 'm3'] },
        { id: 'i2', name: 'Biryani', amount: 62000, participants: ['m1', 'm2'] },
        { id: 'i3', name: 'Lassi', amount: 18000, participants: ['m3'] },
      ],
      tax: 6250,
      tip: 10000,
      discount: 5000,
    },
  };
  assert.equal(validateSplit(expense).ok, true);

  const shares = computeShares(expense);
  assert.equal(totalOf(shares), 136250);

  // m1 and m2 ate identically, so they pay identically, and more than m3.
  assert.equal(shareFor(shares, 'm1'), shareFor(shares, 'm2'));
  assert.ok(shareFor(shares, 'm3') < shareFor(shares, 'm1'));

  // Pre-tax subtotals are 460 / 460 / 330; extras of ₹112.50 spread pro-rata.
  assert.equal(shareFor(shares, 'm1'), 50140);
  assert.equal(shareFor(shares, 'm2'), 50140);
  assert.equal(shareFor(shares, 'm3'), 35970);
  for (const share of shares) assert.ok(share.paise > 0, 'nobody pays zero on this bill');
});

test('itemised: a participant who shared no item pays nothing', () => {
  const expense = {
    amount: 20000,
    splitType: 'itemized',
    participants: ids(3),
    splitData: {
      items: [{ id: 'i1', name: 'Pizza', amount: 20000, participants: ['m1', 'm2'] }],
      tax: 0,
      tip: 0,
      discount: 0,
    },
  };
  const shares = computeShares(expense);
  assert.equal(shareFor(shares, 'm3'), 0);
  assert.equal(totalOf(shares), 20000);
});

test('itemised: tip on free items falls back to an equal split', () => {
  const expense = {
    amount: 300,
    splitType: 'itemized',
    participants: ids(3),
    splitData: {
      items: [{ id: 'i1', name: 'Free water', amount: 0, participants: ['m1', 'm2', 'm3'] }],
      tip: 300,
    },
  };
  assert.equal(validateSplit(expense).ok, true);
  assert.deepEqual(
    computeShares(expense).map((s) => s.paise),
    [100, 100, 100]
  );
});

test('itemised: tax, tip and discount default to zero when omitted', () => {
  const expense = {
    amount: 5000,
    splitType: 'itemized',
    participants: ids(2),
    splitData: { items: [{ name: 'Chai', amount: 5000, participants: ['m1', 'm2'] }] },
  };
  assert.equal(validateSplit(expense).ok, true);
  assert.equal(totalOf(computeShares(expense)), 5000);
});

/* ------------------------------------------------------------------ *
 * Forgiving inputs
 * ------------------------------------------------------------------ */

test('splitData entries for people who are no longer participants are ignored', () => {
  const expense = {
    amount: 30000,
    splitType: 'shares',
    participants: ['m1', 'm2'],
    splitData: { m1: 1, m2: 1, ghost: 8 },
  };
  assert.equal(validateSplit(expense).ok, true);
  const shares = computeShares(expense);
  assert.deepEqual(
    shares.map((s) => s.memberId),
    ['m1', 'm2']
  );
  assert.deepEqual(
    shares.map((s) => s.paise),
    [15000, 15000]
  );
});

/* ------------------------------------------------------------------ *
 * validateSplit rejections
 * ------------------------------------------------------------------ */

const MALFORMED = [
  ['a missing expense', null],
  ['a non-integer amount', { amount: 100.5, splitType: 'equal', participants: ids(2) }],
  ['an absurd amount', { amount: 100000000001, splitType: 'equal', participants: ids(2) }],
  ['an unknown split type', { amount: 1000, splitType: 'vibes', participants: ids(2) }],
  ['no participants', { amount: 1000, splitType: 'equal', participants: [], splitData: {} }],
  ['participants that are not an array', { amount: 1000, splitType: 'equal', participants: 'm1' }],
  ['a duplicated participant', { amount: 1000, splitType: 'equal', participants: ['m1', 'm1'] }],
  ['a blank member id', { amount: 1000, splitType: 'equal', participants: ['m1', '  '] }],

  ['exact amounts that fall short', { amount: 10000, splitType: 'exact', participants: ids(2), splitData: { m1: 5000, m2: 3000 } }],
  ['exact amounts that overshoot', { amount: 10000, splitType: 'exact', participants: ids(2), splitData: { m1: 7000, m2: 5000 } }],
  ['an exact amount left blank', { amount: 10000, splitType: 'exact', participants: ids(2), splitData: { m1: 10000 } }],
  ['a negative exact amount', { amount: 10000, splitType: 'exact', participants: ids(2), splitData: { m1: 11000, m2: -1000 } }],
  ['a fractional exact amount', { amount: 10000, splitType: 'exact', participants: ids(2), splitData: { m1: 5000.5, m2: 4999.5 } }],
  ['exact with no splitData at all', { amount: 10000, splitType: 'exact', participants: ids(2) }],

  ['percentages that do not reach 100', { amount: 10000, splitType: 'percent', participants: ids(2), splitData: { m1: 50, m2: 40 } }],
  ['percentages beyond the tolerance', { amount: 10000, splitType: 'percent', participants: ids(2), splitData: { m1: 50, m2: 50.02 } }],
  ['a negative percentage', { amount: 10000, splitType: 'percent', participants: ids(2), splitData: { m1: 110, m2: -10 } }],
  ['a percentage left blank', { amount: 10000, splitType: 'percent', participants: ids(2), splitData: { m1: 100 } }],
  ['a percentage that is not a number', { amount: 10000, splitType: 'percent', participants: ids(2), splitData: { m1: '50', m2: 50 } }],

  ['shares that are all zero', { amount: 10000, splitType: 'shares', participants: ids(2), splitData: { m1: 0, m2: 0 } }],
  ['a negative share count', { amount: 10000, splitType: 'shares', participants: ids(2), splitData: { m1: 3, m2: -1 } }],
  ['a share count left blank', { amount: 10000, splitType: 'shares', participants: ids(2), splitData: { m1: 2 } }],

  ['adjustments larger than the bill', { amount: 10000, splitType: 'adjustment', participants: ids(2), splitData: { m1: 12000 } }],
  ['a fractional adjustment', { amount: 10000, splitType: 'adjustment', participants: ids(2), splitData: { m1: 12.5 } }],
  ['adjustments that are not a record', { amount: 10000, splitType: 'adjustment', participants: ids(2), splitData: [1, 2] }],

  ['an itemised bill with no items', { amount: 10000, splitType: 'itemized', participants: ids(2), splitData: { items: [] } }],
  ['an itemised bill with no splitData', { amount: 10000, splitType: 'itemized', participants: ids(2) }],
  [
    'an item nobody is sharing',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 10000, participants: [] }] },
    },
  ],
  [
    'an item shared with an outsider',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 10000, participants: ['m1', 'stranger'] }] },
    },
  ],
  [
    'an item listing the same person twice',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 10000, participants: ['m1', 'm1'] }] },
    },
  ],
  [
    'an itemised bill that does not reconcile',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 9000, participants: ['m1', 'm2'] }], tax: 500 },
    },
  ],
  [
    'an item with a negative price',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: {
        items: [
          { name: 'Dosa', amount: 12000, participants: ['m1', 'm2'] },
          { name: 'Refund', amount: -2000, participants: ['m1'] },
        ],
      },
    },
  ],
  [
    'a negative tip',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 11000, participants: ['m1', 'm2'] }], tip: -1000 },
    },
  ],
  [
    'a fractional tax',
    {
      amount: 10000,
      splitType: 'itemized',
      participants: ids(2),
      splitData: { items: [{ name: 'Dosa', amount: 9950, participants: ['m1', 'm2'] }], tax: 50.5 },
    },
  ],
];

for (const [label, expense] of MALFORMED) {
  test(`validateSplit rejects ${label}`, () => {
    const result = validateSplit(expense);
    assert.equal(result.ok, false, `expected ${label} to be rejected`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.trim().length > 0, 'error must be a real sentence');
    assert.throws(() => computeShares(expense), RangeError);
  });
}

test('exact shortfall names the amount left to assign', () => {
  const result = validateSplit({
    amount: 10000,
    splitType: 'exact',
    participants: ids(2),
    splitData: { m1: 5000, m2: 3000 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /₹20\.00/);
  assert.match(result.error, /left to assign/);
});

test('exact excess names the overshoot', () => {
  const result = validateSplit({
    amount: 10000,
    splitType: 'exact',
    participants: ids(2),
    splitData: { m1: 7000, m2: 5000 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /₹20\.00/);
});

test('an itemised bill that does not reconcile names the gap', () => {
  const result = validateSplit({
    amount: 10000,
    splitType: 'itemized',
    participants: ids(2),
    splitData: { items: [{ name: 'Dosa', amount: 8000, participants: ['m1', 'm2'] }] },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /₹20\.00/);
});

test('validateSplit returns exactly {ok: true} for a good split', () => {
  assert.deepEqual(validateSplit(equalExpense(10000, 4)), { ok: true });
});

/* ------------------------------------------------------------------ *
 * describeSplit
 * ------------------------------------------------------------------ */

const MEMBERS = {
  m1: { id: 'm1', name: 'Asha' },
  m2: { id: 'm2', name: 'Ravi' },
  m3: { id: 'm3', name: 'Neha' },
  m4: { id: 'm4', name: 'Imran' },
};

test('describeSplit returns a non-empty label for every split type', () => {
  for (const splitType of SPLIT_TYPES) {
    const label = describeSplit(BUILDERS[splitType](50000, 4), MEMBERS);
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `${splitType} produced an empty label`);
  }
});

test('describeSplit: equal', () => {
  assert.equal(describeSplit(equalExpense(10000, 4), MEMBERS), 'Split equally between 4');
  assert.equal(describeSplit(equalExpense(10000, 1), MEMBERS), 'All on Asha');
  assert.equal(describeSplit(equalExpense(10000, 1), undefined), 'All on one person');
});

test('describeSplit: exact', () => {
  assert.equal(describeSplit(exactExpense(10000, 3), MEMBERS), 'Exact amounts');
});

test('describeSplit: shares reads as a ratio', () => {
  const expense = {
    amount: 40000,
    splitType: 'shares',
    participants: ids(3),
    splitData: { m1: 2, m2: 1, m3: 1 },
  };
  assert.equal(describeSplit(expense, MEMBERS), 'By shares (2:1:1)');
});

test('describeSplit: percent reads as a list', () => {
  const expense = {
    amount: 40000,
    splitType: 'percent',
    participants: ids(3),
    splitData: { m1: 50, m2: 30, m3: 20 },
  };
  assert.equal(describeSplit(expense, MEMBERS), 'By percentage (50% / 30% / 20%)');
});

test('describeSplit: adjustment counts the adjusted people', () => {
  const two = {
    amount: 60000,
    splitType: 'adjustment',
    participants: ids(3),
    splitData: { m1: 15000, m2: -2000, m3: 0 },
  };
  assert.equal(describeSplit(two, MEMBERS), 'Adjusted for 2 people');

  const one = {
    amount: 60000,
    splitType: 'adjustment',
    participants: ids(3),
    splitData: { m2: 15000 },
  };
  assert.equal(describeSplit(one, MEMBERS), 'Adjusted for Ravi');

  const none = { amount: 60000, splitType: 'adjustment', participants: ids(3), splitData: {} };
  assert.equal(describeSplit(none, MEMBERS), 'Split equally between 3');
});

test('describeSplit: itemised counts items and handles the singular', () => {
  assert.equal(describeSplit(itemisedExpense(100000, 3), MEMBERS), 'Itemised · 3 items');

  const single = {
    amount: 10000,
    splitType: 'itemized',
    participants: ids(2),
    splitData: { items: [{ name: 'Dosa', amount: 10000, participants: ['m1', 'm2'] }] },
  };
  assert.equal(describeSplit(single, MEMBERS), 'Itemised · 1 item');
});

test('describeSplit accepts a Map of members', () => {
  const map = new Map(Object.entries(MEMBERS));
  assert.equal(describeSplit(equalExpense(10000, 1), map), 'All on Asha');
});

test('describeSplit never throws on malformed input', () => {
  for (const bad of [null, undefined, {}, { splitType: 'vibes' }, { splitType: 'shares' }, { splitType: 'itemized' }]) {
    const label = describeSplit(bad, MEMBERS);
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0);
  }
});

test('describeSplit falls back to a summary for large parties', () => {
  assert.equal(describeSplit(sharesExpense(10000, 8), MEMBERS), 'By shares across 8');
  assert.equal(describeSplit(percentExpense(10000, 8), MEMBERS), 'By percentage across 8');
});
