/**
 * upi.js — UPI deep-link construction and defensive parsing.
 *
 * Builds NPCI-compliant `upi://pay?...` intent URIs. Pure module: no DOM, no
 * storage, no globals. Money arrives as integer paise and is serialised to the
 * rupee string the `am=` parameter requires (always exactly two decimals).
 *
 * Encoding note — why this module does NOT use URLSearchParams to BUILD:
 * `URLSearchParams#toString()` emits application/x-www-form-urlencoded, which
 * encodes a space as "+". Browsers and PSP apps do not agree that "+" means a
 * space inside a non-special scheme like `upi:`; the NPCI intent spec expects
 * percent-encoding, so many apps take the "+" literally and a note of
 * "Goa Trip settle" reaches the payer as "Goa+Trip+settle". We therefore build
 * the query by hand with encodeURIComponent, which emits %20 for a space.
 * Parsing still accepts the legacy "+" form, because other apps emit it.
 */
import { paiseToUpiAmount, MAX_PAISE } from './money.js';

/** Known Indian UPI handles, for the autocomplete datalist. */
export const UPI_HANDLES = Object.freeze([
  'upi', 'ybl', 'okaxis', 'okhdfcbank', 'oksbi', 'okicici', 'paytm', 'ibl', 'axl', 'fbl', 'apl', 'sbi', 'hdfcbank', 'icici', 'axisbank', 'kotak', 'idfcbank',
]);

/** Stable emission order of the UPI query parameters. */
export const UPI_PARAM_ORDER = Object.freeze(['pa', 'pn', 'am', 'cu', 'tn', 'tr', 'mc']);

// Local part: unreserved-ish, must start AND end with an alphanumeric, so
// ".rhea@ybl" and "rhea.@ybl" are both rejected.
const VPA_LOCAL = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
// Handle: dot-separated labels, each starting with a letter and ending
// alphanumeric — rejects "@okhdfcbank." and "@ok..bank".
const VPA_HANDLE = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Strict VPA check: `user@handle`.
 * @param {unknown} vpa
 * @returns {{ok: true, normalized: string} | {ok: false, error: string}}
 */
export function validateVpa(vpa) {
  if (typeof vpa !== 'string') return { ok: false, error: 'Enter a UPI ID.' };
  const normalized = vpa.trim().toLowerCase();
  if (!normalized) return { ok: false, error: 'Enter a UPI ID.' };
  if (normalized.length > 320) return { ok: false, error: 'That UPI ID is too long.' };
  if (/\s/.test(normalized)) return { ok: false, error: 'A UPI ID cannot contain spaces.' };

  const parts = normalized.split('@');
  if (parts.length !== 2) return { ok: false, error: 'A UPI ID needs exactly one @, like name@bank.' };

  const [local, handle] = parts;
  if (local.length < 2 || local.length > 256 || !VPA_LOCAL.test(local)) {
    return { ok: false, error: 'Use a UPI ID like name@bank.' };
  }
  if (handle.length < 2 || handle.length > 64 || !VPA_HANDLE.test(handle)) {
    return { ok: false, error: 'Use a bank handle like @okhdfcbank.' };
  }
  return { ok: true, normalized };
}

/**
 * Build a `upi://pay?...` intent URI.
 * @param {{pa: string, pn: string, am: number, tn?: string, tr?: string, mc?: string, cu?: string}} params
 *   `am` is integer PAISE and is serialised as rupees with exactly 2 decimals.
 * @returns {string}
 */
export function buildUpiUri(params = {}) {
  const vpa = validateVpa(params.pa);
  if (!vpa.ok) throw new RangeError(vpa.error);

  const name = clean(params.pn, 80);
  if (!name) throw new RangeError('A payee name is required.');

  if (!Number.isInteger(params.am) || params.am <= 0) {
    throw new RangeError('UPI payments need a positive whole-paise amount.');
  }
  if (params.am > MAX_PAISE) throw new RangeError('That amount is too large for a UPI payment.');

  const note = clean(params.tn, 50);
  const ref = clean(params.tr, 35).replace(/[^a-zA-Z0-9]/g, '');
  const merchantCode = clean(params.mc, 4).replace(/\D/g, '');

  /** @type {Record<string, string>} */
  const values = {
    pa: vpa.normalized,
    pn: name,
    am: paiseToUpiAmount(params.am),
    cu: currencyCode(params.cu),
    tn: note,
    tr: ref,
    mc: merchantCode,
  };

  const pairs = [];
  for (const key of UPI_PARAM_ORDER) {
    const value = values[key];
    if (value === '') continue; // omit empty optionals entirely — never emit a bare "&tn="
    // `pa` is emitted UNENCODED on purpose. A validated VPA only contains
    // unreserved characters plus a single "@", so there is nothing that needs
    // escaping; and real PSP parsers commonly split the payee on a LITERAL "@".
    // "pa=user%40bank" is technically valid URI syntax but needlessly fragile,
    // so we keep the "@" literal. Every other value is percent-encoded.
    pairs.push(`${key}=${key === 'pa' ? value : encodeURIComponent(value)}`);
  }
  return `upi://pay?${pairs.join('&')}`;
}

/**
 * App-specific links so the UI can offer "Open in GPay / PhonePe / Paytm".
 * Every entry carries the identical query built by {@link buildUpiUri}.
 * @returns {Array<{id: string, name: string, url: string, color: string}>}
 */
export function buildAppLinks(params) {
  const universal = buildUpiUri(params);
  const query = universal.slice(universal.indexOf('?') + 1);
  return [
    { id: 'upi', name: 'Any UPI app', url: universal, color: '#5233c9' },
    { id: 'gpay', name: 'Google Pay', url: `tez://upi/pay?${query}`, color: '#4285f4' },
    { id: 'phonepe', name: 'PhonePe', url: `phonepe://pay?${query}`, color: '#5f259f' },
    { id: 'paytm', name: 'Paytm', url: `paytmmp://pay?${query}`, color: '#00baf2' },
  ];
}

/**
 * Parse a `upi://pay?...` URI back into params (import / paste flow).
 * Accepts both the percent-encoded form this module emits and the legacy
 * "+"-for-space form other apps emit.
 * @param {unknown} uri
 * @returns {{pa: string, pn: string, am: number|null, tn: string, tr: string, mc: string, cu: string}}
 */
export function parseUpiUri(uri) {
  if (typeof uri !== 'string') throw new RangeError('Enter a UPI payment link.');
  const text = uri.trim();
  const match = /^upi:(\/\/)?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(text);
  if (!match) throw new RangeError('That is not a valid UPI payment link.');

  const host = match[2].replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  if (host !== 'pay') throw new RangeError('Expected a upi://pay link.');

  const query = decodeQuery(match[3] || '');
  const validation = validateVpa(query.get('pa') || '');
  if (!validation.ok) throw new RangeError(validation.error);

  return {
    pa: validation.normalized,
    pn: query.get('pn') || '',
    am: parseUpiAmount(query.get('am')),
    tn: query.get('tn') || '',
    tr: query.get('tr') || '',
    mc: query.get('mc') || '',
    cu: currencyCode(query.get('cu')),
  };
}

/**
 * Deterministic, UPI-safe transaction reference for a settlement.
 * Uppercase alphanumeric, well under the 35-character `tr` limit, and stable
 * for the same (group, from, to, amount) tuple.
 * @param {string} groupId
 * @param {{from?: string, to?: string, paise?: number}} transfer
 * @returns {string}
 */
export function settlementRef(groupId, transfer) {
  const seed = `${groupId || 'group'}|${transfer?.from || ''}|${transfer?.to || ''}|${Math.trunc(transfer?.paise || 0)}`;
  // Two FNV-1a passes with different offset bases widen the reference from 32
  // to 64 bits, which makes an accidental collision between two settlements in
  // the same group effectively impossible.
  const a = fnv1a(seed, 2166136261);
  const b = fnv1a(seed, 2166136261 ^ 0x5bf03635);
  return `SPU${base36(a)}${base36(b)}`.slice(0, 35);
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function fnv1a(text, offset) {
  let hash = offset >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= text.charCodeAt(i) >>> 8;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function base36(n) {
  return n.toString(36).toUpperCase().padStart(7, '0');
}

/** ISO-4217-ish code; UPI only settles in INR today, so that is the fallback. */
function currencyCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : 'INR';
}

/**
 * Trim, strip control characters, and cap the length WITHOUT splitting a
 * surrogate pair — a lone surrogate would make encodeURIComponent throw.
 */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (s.length > max) {
    s = s.slice(0, max);
    // Drop a trailing high surrogate whose partner was just cut off.
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** Parse the `am=` rupee string back to integer paise with no float drift. */
function parseUpiAmount(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** Decode a query string into a Map. First occurrence of a key wins. */
function decodeQuery(query) {
  const out = new Map();
  for (const chunk of query.split('&')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    const key = decodeComponent(eq === -1 ? chunk : chunk.slice(0, eq));
    if (!key || out.has(key)) continue;
    out.set(key, decodeComponent(eq === -1 ? '' : chunk.slice(eq + 1)));
  }
  return out;
}

/**
 * We never emit "+" for a space, but other UPI apps do, so reading one back
 * must still yield a space. Malformed percent escapes are kept verbatim
 * rather than throwing — this runs on pasted, untrusted text.
 */
function decodeComponent(part) {
  const spaced = part.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}
