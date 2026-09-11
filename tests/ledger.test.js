import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBalances, computePairwiseDebts, categoryTotals, monthlyTotals } from '../src/core/balances.js';
import { minimiseTransfers, applyTransfers } from '../src/core/settle.js';
import { buildUpiUri, parseUpiUri, validateVpa } from '../src/core/upi.js';
import { parseCsv, expensesToCsv } from '../src/core/csv.js';
import { encodeQR, toSvg } from '../src/core/qr.js';

const group = {
  id: 'grp_test', name: 'Test group', members: [
    { id: 'a', name: 'Asha' }, { id: 'b', name: 'Bina' }, { id: 'c', name: 'Chirag' },
  ],
  expenses: [
    { id: 'e1', description: 'Dinner', amount: 5000, paidBy: [{ memberId: 'a', paise: 5000 }], participants: ['a', 'b'], splitType: 'equal', splitData: {}, category: 'Food', date: '2026-09-01' },
    { id: 'e2', description: 'Cab', amount: 3000, paidBy: [{ memberId: 'b', paise: 3000 }], participants: ['b', 'c'], splitType: 'equal', splitData: {}, category: 'Travel', date: '2026-09-02' },
  ],
  settlements: [{ id: 's1', from: 'c', to: 'a', paise: 500, method: 'upi', date: '2026-09-03' }],
};

test('ledger balances reconcile after expenses and settlements', () => {
  const balances = computeBalances(group);
  assert.deepEqual(Object.fromEntries(balances.map((item) => [item.memberId, item.net])), { a: 2000, b: -1000, c: -1000 });
  assert.equal(balances.reduce((total, item) => total + item.net, 0), 0);
  const plan = minimiseTransfers(balances);
  assert.equal(plan.length, 2);
  assert.ok(applyTransfers(balances, plan).every((item) => item.net === 0));
  assert.ok(computePairwiseDebts(group).every((item) => item.paise > 0));
});

test('ledger reporting aggregates categories and months', () => {
  assert.deepEqual(categoryTotals(group), [{ category: 'Food', paise: 5000 }, { category: 'Travel', paise: 3000 }]);
  assert.deepEqual(monthlyTotals(group), [{ month: '2026-09', paise: 8000 }]);
  assert.equal(parseCsv(expensesToCsv(group)).length, 3);
});

test('UPI URI preserves the exact paise amount', () => {
  assert.equal(validateVpa('asha@okaxis').ok, true);
  const uri = buildUpiUri({ pa: 'asha@okaxis', pn: 'Asha Shah', am: 12345, tn: 'Dinner split', tr: 'SPLIT001' });
  assert.match(uri, /^upi:\/\/pay\?/);
  assert.deepEqual(parseUpiUri(uri), { pa: 'asha@okaxis', pn: 'Asha Shah', am: 12345, tn: 'Dinner split', tr: 'SPLIT001', mc: '', cu: 'INR' });
});

test('QR encoder returns a square boolean matrix and standalone SVG', () => {
  const qr = encodeQR('upi://pay?pa=asha%40okaxis&pn=Asha&am=123.45&cu=INR', { ecc: 'M' });
  assert.equal(qr.size, qr.modules.length);
  assert.ok(qr.modules.every((row) => row.length === qr.size && row.every((cell) => typeof cell === 'boolean')));
  assert.match(toSvg(qr), /^<svg /);
});
