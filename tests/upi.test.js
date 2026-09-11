import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateVpa,
  buildUpiUri,
  buildAppLinks,
  parseUpiUri,
  settlementRef,
  UPI_HANDLES,
} from '../src/core/upi.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 32-bit PRNG (mulberry32) — tests must never use Math.random. */
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The query half of a upi:// URI, still percent-encoded. */
function queryOf(uri) {
  return uri.slice(uri.indexOf('?') + 1);
}

/** Read one raw (still-encoded) parameter out of a built URI. */
function rawParam(uri, key) {
  for (const chunk of queryOf(uri).split('&')) {
    const eq = chunk.indexOf('=');
    if (chunk.slice(0, eq) === key) return chunk.slice(eq + 1);
  }
  return null;
}

const BASE = { pa: 'nischay@okhdfcbank', pn: 'Nischay Prasuna', am: 125000 };

/* ------------------------------------------------------------------ */
/* validateVpa                                                         */
/* ------------------------------------------------------------------ */

test('validateVpa accepts realistic Indian VPAs', () => {
  const good = ['nischay@okhdfcbank', 'rhea.k@ybl', 'arjun1998@paytm', 'a_b-c@oksbi'];
  for (const vpa of good) {
    const result = validateVpa(vpa);
    assert.equal(result.ok, true, `expected ${vpa} to be accepted`);
    assert.equal(result.normalized, vpa);
    assert.equal(result.error, undefined);
  }
});

test('validateVpa trims and lowercases before normalising', () => {
  assert.deepEqual(validateVpa('  Nischay@OKHDFCBANK  '), { ok: true, normalized: 'nischay@okhdfcbank' });
});

test('validateVpa rejects malformed VPAs with a non-empty error', () => {
  const bad = {
    'no handle': 'nischay',
    'double @': 'nischay@@okhdfcbank',
    'two handles': 'nischay@ok@hdfcbank',
    'space inside': 'ni schay@okhdfcbank',
    'leading dot': '.nischay@okhdfcbank',
    'trailing dot in local part': 'nischay.@okhdfcbank',
    'trailing dot in handle': 'nischay@okhdfcbank.',
    'empty': '',
    'only whitespace': '   ',
    'handle missing': 'nischay@',
    'local missing': '@okhdfcbank',
    'not a string': null,
  };
  for (const [label, vpa] of Object.entries(bad)) {
    const result = validateVpa(vpa);
    assert.equal(result.ok, false, `expected ${label} (${String(vpa)}) to be rejected`);
    assert.equal(typeof result.error, 'string', `${label} must carry an error string`);
    assert.ok(result.error.length > 0, `${label} must carry a non-empty error`);
    assert.equal(result.normalized, undefined);
  }
});

test('UPI_HANDLES is a frozen list of plain lowercase handles', () => {
  assert.ok(Object.isFrozen(UPI_HANDLES));
  assert.ok(UPI_HANDLES.length > 5);
  for (const handle of UPI_HANDLES) {
    assert.match(handle, /^[a-z][a-z0-9.]*$/);
    assert.equal(validateVpa(`nischay@${handle}`).ok, true, `nischay@${handle} should validate`);
  }
});

/* ------------------------------------------------------------------ */
/* buildUpiUri — exact output                                          */
/* ------------------------------------------------------------------ */

test('buildUpiUri produces the exact expected URI for a known input', () => {
  const uri = buildUpiUri({
    pa: 'nischay@okhdfcbank',
    pn: 'Nischay Prasuna',
    am: 125000,
    tn: 'Goa Trip settle',
    tr: 'SPU7X2K9',
    mc: '5499',
  });
  assert.equal(
    uri,
    'upi://pay?pa=nischay@okhdfcbank&pn=Nischay%20Prasuna&am=1250.00&cu=INR&tn=Goa%20Trip%20settle&tr=SPU7X2K9&mc=5499',
  );
});

test('buildUpiUri keeps the parameter order pa, pn, am, cu, tn, tr, mc', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'Dinner', tr: 'SPUABC123', mc: '5812' });
  const keys = queryOf(uri).split('&').map((chunk) => chunk.slice(0, chunk.indexOf('=')));
  assert.deepEqual(keys, ['pa', 'pn', 'am', 'cu', 'tn', 'tr', 'mc']);
});

/* ------------------------------------------------------------------ */
/* the encoding bug: "+" must never appear                             */
/* ------------------------------------------------------------------ */

test('a note with spaces encodes as %20 and NEVER as "+"', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'Goa Trip settle' });
  assert.equal(rawParam(uri, 'tn'), 'Goa%20Trip%20settle');
  assert.ok(!uri.includes('+'), `URI must not contain "+": ${uri}`);
  assert.match(uri, /tn=Goa%20Trip%20settle/);
  // Regression guard: URLSearchParams would have produced "Goa+Trip+settle".
  assert.ok(!uri.includes('Goa+Trip+settle'));
});

test('no built URI ever contains a "+" for any spaced field', () => {
  const uri = buildUpiUri({
    pa: 'rhea.k@ybl',
    pn: 'Rhea   K Sharma',
    am: 999,
    tn: 'Team lunch at Blue Tokai',
  });
  assert.ok(!uri.includes('+'), uri);
  assert.equal(rawParam(uri, 'pn'), 'Rhea%20%20%20K%20Sharma');
  assert.equal(parseUpiUri(uri).tn, 'Team lunch at Blue Tokai');
});

test('a literal "+" inside a note is percent-encoded as %2B and survives the round trip', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'Tip + tax' });
  assert.equal(rawParam(uri, 'tn'), 'Tip%20%2B%20tax');
  assert.ok(!queryOf(uri).includes('+'));
  assert.equal(parseUpiUri(uri).tn, 'Tip + tax');
});

test('reserved characters in a note cannot break out of their parameter', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'a&pa=evil@ybl=b#c?d' });
  assert.equal(rawParam(uri, 'tn'), 'a%26pa%3Devil%40ybl%3Db%23c%3Fd');
  const parsed = parseUpiUri(uri);
  assert.equal(parsed.pa, 'nischay@okhdfcbank');
  assert.equal(parsed.tn, 'a&pa=evil@ybl=b#c?d');
});

/* ------------------------------------------------------------------ */
/* pa stays literal                                                    */
/* ------------------------------------------------------------------ */

test('pa is emitted with a literal "@", never %40', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'Goa Trip settle' });
  assert.ok(uri.includes('pa=nischay@okhdfcbank'), uri);
  assert.ok(!uri.includes('%40'), uri);
  assert.equal(rawParam(uri, 'pa'), 'nischay@okhdfcbank');
});

/* ------------------------------------------------------------------ */
/* amount serialisation                                                */
/* ------------------------------------------------------------------ */

test('amounts serialise as rupees with exactly two decimals', () => {
  const table = [
    [1250, '12.50'],
    [100000, '1000.00'],
    [1, '0.01'],
    [2087083, '20870.83'],
    [100, '1.00'],
    [99, '0.99'],
    [10, '0.10'],
    [123456789, '1234567.89'],
  ];
  for (const [paise, expected] of table) {
    const uri = buildUpiUri({ ...BASE, am: paise });
    const am = rawParam(uri, 'am');
    assert.equal(am, expected, `${paise} paise should serialise as ${expected}`);
    assert.match(am, /^\d+\.\d{2}$/, `${am} must be plain decimal, never scientific notation`);
    assert.ok(!/[eE]/.test(am), `${am} must not use scientific notation`);
    assert.equal(parseUpiUri(uri).am, paise, 'amount must round-trip to the same integer paise');
  }
});

test('tiny and large amounts avoid floating-point drift on the way back', () => {
  // 0.29 * 100 === 28.999999999999996 in binary floating point; the parser must
  // not lose that paisa.
  for (const paise of [29, 820, 1001, 2087083, 999999, 7010, 1234599]) {
    const uri = buildUpiUri({ ...BASE, am: paise });
    const back = parseUpiUri(uri).am;
    assert.equal(back, paise);
    assert.ok(Number.isInteger(back));
  }
});

test('buildUpiUri rejects amounts that are not positive whole paise', () => {
  for (const am of [0, -100, 12.5, NaN, Infinity, '1250', null, undefined]) {
    assert.throws(() => buildUpiUri({ ...BASE, am }), RangeError, `am=${String(am)} must throw`);
  }
});

test('buildUpiUri rejects a bad payee or a missing payee name', () => {
  assert.throws(() => buildUpiUri({ ...BASE, pa: 'not-a-vpa' }), RangeError);
  assert.throws(() => buildUpiUri({ ...BASE, pn: '   ' }), RangeError);
  assert.throws(() => buildUpiUri({ ...BASE, pn: undefined }), RangeError);
});

/* ------------------------------------------------------------------ */
/* unicode                                                             */
/* ------------------------------------------------------------------ */

test('a Unicode note encodes as UTF-8 percent escapes and round-trips identically', () => {
  const note = 'Goa trip ✈️';
  const uri = buildUpiUri({ ...BASE, tn: note });
  assert.equal(rawParam(uri, 'tn'), 'Goa%20trip%20%E2%9C%88%EF%B8%8F');
  assert.ok(!uri.includes('+'));
  assert.equal(parseUpiUri(uri).tn, note);
});

test('Devanagari and rupee glyphs survive the round trip', () => {
  const note = 'गोवा ₹500 का हिस्सा';
  const uri = buildUpiUri({ ...BASE, tn: note, pn: 'ऋचा शर्मा' });
  const parsed = parseUpiUri(uri);
  assert.equal(parsed.tn, note);
  assert.equal(parsed.pn, 'ऋचा शर्मा');
  assert.ok(!uri.includes('+'));
});

test('an over-long emoji note is truncated without producing a lone surrogate', () => {
  const note = '🎉'.repeat(40); // 80 UTF-16 units, cap is 50
  const uri = buildUpiUri({ ...BASE, tn: note });
  const back = parseUpiUri(uri).tn;
  assert.ok(back.length <= 50);
  assert.equal(back, '🎉'.repeat(25));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(back), 'no dangling high surrogate');
});

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

test('legacy "+"-encoded links still parse back with real spaces', () => {
  const parsed = parseUpiUri('upi://pay?pa=rhea.k@ybl&pn=Rhea+K&am=1250.00&cu=INR&tn=Goa+Trip+settle&tr=SPU7X2K9');
  assert.deepEqual(parsed, {
    pa: 'rhea.k@ybl',
    pn: 'Rhea K',
    am: 125000,
    tn: 'Goa Trip settle',
    tr: 'SPU7X2K9',
    mc: '',
    cu: 'INR',
  });
});

test('a percent-encoded payee (pa=user%40bank) is still accepted when parsing', () => {
  const parsed = parseUpiUri('upi://pay?pa=nischay%40okhdfcbank&pn=Nischay&am=5.00');
  assert.equal(parsed.pa, 'nischay@okhdfcbank');
  assert.equal(parsed.am, 500);
});

test('parseUpiUri round-trips everything buildUpiUri emits', () => {
  const params = { pa: 'arjun1998@paytm', pn: 'Arjun Rao', am: 45678, tn: 'Cab to airport', tr: 'SPUZZ99', mc: '4121' };
  const parsed = parseUpiUri(buildUpiUri(params));
  assert.deepEqual(parsed, { ...params, cu: 'INR' });
});

test('parseUpiUri rejects anything that is not a upi://pay link', () => {
  for (const bad of ['', 'not a link', 'https://example.com/pay?pa=a@b', 'upi://collect?pa=nischay@okhdfcbank', 42, null]) {
    assert.throws(() => parseUpiUri(bad), RangeError, `${String(bad)} must throw`);
  }
  // A well-formed link with an unusable payee is rejected too.
  assert.throws(() => parseUpiUri('upi://pay?pa=bogus&am=1.00'), RangeError);
});

test('a missing or malformed amount parses as null rather than NaN', () => {
  assert.equal(parseUpiUri('upi://pay?pa=rhea.k@ybl&pn=Rhea').am, null);
  assert.equal(parseUpiUri('upi://pay?pa=rhea.k@ybl&am=12.345').am, null);
  assert.equal(parseUpiUri('upi://pay?pa=rhea.k@ybl&am=abc').am, null);
  assert.equal(parseUpiUri('upi://pay?pa=rhea.k@ybl&am=12.3').am, 1230);
});

test('round trip holds for a deterministic sweep of generated notes', () => {
  const rand = prng(20260911);
  const pool = [...'abcdefghijklmnopqrstuvwxyzABCXYZ0123456789 .,&=+%#?/@:₹', '✈️', '🍕', 'ज'];
  for (let i = 0; i < 200; i += 1) {
    const len = 1 + Math.floor(rand() * 30);
    let note = '';
    for (let k = 0; k < len; k += 1) note += pool[Math.floor(rand() * pool.length)];
    note = note.trim();
    if (!note) continue;
    const am = 1 + Math.floor(rand() * 10000000);
    const uri = buildUpiUri({ ...BASE, am, tn: note });
    assert.ok(!queryOf(uri).includes('+'), `query must never contain a raw "+": ${uri}`);
    const parsed = parseUpiUri(uri);
    assert.equal(parsed.tn, note, `note round trip failed for ${JSON.stringify(note)}`);
    assert.equal(parsed.am, am);
    assert.equal(parsed.pa, BASE.pa);
  }
});

/* ------------------------------------------------------------------ */
/* omitted optional parameters                                         */
/* ------------------------------------------------------------------ */

test('omitted optional params never appear, not even as empty keys', () => {
  const uri = buildUpiUri(BASE);
  assert.equal(uri, 'upi://pay?pa=nischay@okhdfcbank&pn=Nischay%20Prasuna&am=1250.00&cu=INR');
  for (const key of ['tn', 'tr', 'mc']) {
    assert.ok(!uri.includes(`${key}=`), `${key} must be absent entirely`);
    assert.ok(!uri.includes(`&${key}=&`));
  }
  assert.ok(!uri.endsWith('&'));
  assert.ok(!uri.includes('&&'));
});

test('blank and whitespace-only optionals are dropped, not emitted empty', () => {
  for (const blank of ['', '   ', null, undefined, 123]) {
    const uri = buildUpiUri({ ...BASE, tn: blank, tr: blank, mc: blank });
    assert.equal(uri, 'upi://pay?pa=nischay@okhdfcbank&pn=Nischay%20Prasuna&am=1250.00&cu=INR');
  }
  // A ref made only of punctuation sanitises to nothing and is therefore dropped.
  assert.equal(rawParam(buildUpiUri({ ...BASE, tr: '---' }), 'tr'), null);
  // A merchant code with no digits is dropped too.
  assert.equal(rawParam(buildUpiUri({ ...BASE, mc: 'abcd' }), 'mc'), null);
});

test('tr is sanitised to alphanumerics within the 35-character UPI limit', () => {
  const uri = buildUpiUri({ ...BASE, tr: 'spu-7x2/k9 #trip' });
  assert.equal(rawParam(uri, 'tr'), 'spu7x2k9trip');
  const long = buildUpiUri({ ...BASE, tr: 'A'.repeat(60) });
  assert.equal(rawParam(long, 'tr').length, 35);
});

test('control characters in a note are neutralised', () => {
  const uri = buildUpiUri({ ...BASE, tn: 'Goa\r\nTrip\tsettle' });
  assert.equal(parseUpiUri(uri).tn, 'Goa  Trip settle');
  assert.ok(!/[\r\n\t]/.test(uri));
});

/* ------------------------------------------------------------------ */
/* settlementRef                                                       */
/* ------------------------------------------------------------------ */

test('settlementRef is deterministic, short and UPI-safe', () => {
  const transfer = { from: 'm_asha', to: 'm_rhea', paise: 125000 };
  const ref = settlementRef('grp_goa2026', transfer);
  assert.equal(ref, settlementRef('grp_goa2026', { ...transfer }), 'same input must give the same ref');
  assert.ok(ref.length > 0 && ref.length <= 35, `ref length ${ref.length} must be 1..35`);
  assert.match(ref, /^[A-Z0-9]+$/, 'ref must be uppercase alphanumeric only');
  assert.equal(ref, ref.toUpperCase());
});

test('settlementRef differs for different transfers', () => {
  const base = { from: 'm_asha', to: 'm_rhea', paise: 125000 };
  const variants = [
    settlementRef('grp_goa2026', base),
    settlementRef('grp_goa2026', { ...base, paise: 125001 }),
    settlementRef('grp_goa2026', { ...base, from: 'm_rhea', to: 'm_asha' }),
    settlementRef('grp_goa2026', { ...base, to: 'm_arjun' }),
    settlementRef('grp_diwali', base),
  ];
  assert.equal(new Set(variants).size, variants.length, `refs collided: ${variants.join(', ')}`);
});

test('settlementRef stays valid for missing or odd input and for many transfers', () => {
  assert.match(settlementRef(undefined, undefined), /^[A-Z0-9]{1,35}$/);
  assert.match(settlementRef('', {}), /^[A-Z0-9]{1,35}$/);

  const rand = prng(7734);
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const ref = settlementRef(`grp_${Math.floor(rand() * 1000)}`, {
      from: `m_${Math.floor(rand() * 50)}`,
      to: `m_${Math.floor(rand() * 50)}`,
      paise: 1 + Math.floor(rand() * 5000000),
    });
    assert.match(ref, /^[A-Z0-9]{1,35}$/);
    seen.add(ref);
  }
  assert.ok(seen.size > 380, `expected near-unique refs, got ${seen.size} distinct of 400`);
});

test('a settlementRef survives buildUpiUri unchanged as the tr parameter', () => {
  const ref = settlementRef('grp_goa2026', { from: 'm_asha', to: 'm_rhea', paise: 125000 });
  const uri = buildUpiUri({ ...BASE, tr: ref });
  assert.equal(rawParam(uri, 'tr'), ref);
  assert.equal(parseUpiUri(uri).tr, ref);
});

/* ------------------------------------------------------------------ */
/* buildAppLinks                                                       */
/* ------------------------------------------------------------------ */

test('buildAppLinks returns entries whose urls all carry the encoded payee', () => {
  const params = { ...BASE, tn: 'Goa Trip settle', tr: 'SPU7X2K9' };
  const links = buildAppLinks(params);
  const expectedQuery = queryOf(buildUpiUri(params));

  assert.ok(links.length >= 4);
  const ids = links.map((link) => link.id);
  assert.deepEqual(ids, ['upi', 'gpay', 'phonepe', 'paytm']);
  assert.equal(new Set(ids).size, ids.length);

  for (const link of links) {
    assert.equal(typeof link.id, 'string');
    assert.ok(link.name.length > 0, 'every app link needs a label');
    assert.match(link.color, /^#[0-9a-f]{6}$/i);
    assert.ok(link.url.includes(`pa=${params.pa}`), `${link.id} must carry the payee: ${link.url}`);
    assert.ok(link.url.endsWith(expectedQuery), `${link.id} must carry the identical query: ${link.url}`);
    assert.ok(link.url.includes('tn=Goa%20Trip%20settle'), `${link.id} must percent-encode the note`);
    assert.ok(!link.url.includes('+'), `${link.id} must not contain "+": ${link.url}`);
    assert.ok(!link.url.includes('%40'), `${link.id} must keep the payee "@" literal`);
  }
  assert.equal(links[0].url, buildUpiUri(params));
});

test('buildAppLinks refuses to build anything when the payee is invalid', () => {
  assert.throws(() => buildAppLinks({ ...BASE, pa: 'nope' }), RangeError);
});
