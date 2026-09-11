/**
 * share.js — pack a whole group into a URL fragment so it can be sent over
 * WhatsApp with no server in the middle.
 *
 * Pipeline:
 *   group -> normalise (validate + coerce) -> shorten keys -> JSON -> UTF-8
 *         -> DEFLATE (raw) when `CompressionStream` exists -> base64url
 *         -> single-character version prefix
 *
 * Token versions:
 *   "C…"  the body is a raw DEFLATE stream (CompressionStream('deflate-raw'))
 *   "P…"  the body is plain UTF-8 JSON (fallback for engines without
 *         CompressionStream); decoding never needs the compression API.
 *
 * Decoding is defensive by construction: the payload arrives from a stranger's
 * link, so it is size-capped while it is still a stream, JSON-parsed, then
 * rebuilt field by field into a known shape. Nothing is ever evaluated and no
 * key from the payload is copied onto a prototype.
 *
 * This module is allowed to look at `globalThis.location` (see ARCHITECTURE.md);
 * it holds no other state and touches no DOM.
 */

import { MAX_PAISE } from './money.js';

/** Token prefix: DEFLATE-compressed body. */
const TOKEN_DEFLATED = 'C';
/** Token prefix: uncompressed body. */
const TOKEN_PLAIN = 'P';

/** Hard ceiling on the decoded JSON, in bytes. Guards against zip bombs. */
const MAX_PAYLOAD_BYTES = 512 * 1024;

/** Hard ceiling on the token itself. base64 costs ~4 characters per 3 bytes. */
const MAX_TOKEN_CHARS = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 16;

/**
 * Long key -> short key. Fixed forever: changing an entry invalidates every
 * link already shared, so new fields get new codes instead of reusing one.
 */
const KEY_MAP = Object.freeze({
  // group
  id: 'i',
  name: 'n',
  emoji: 'j',
  type: 't',
  createdAt: 'c',
  members: 'm',
  expenses: 'e',
  settlements: 's',
  recurring: 'r',
  // member
  upi: 'u',
  colorIndex: 'k',
  // expense
  description: 'd',
  amount: 'a',
  paidBy: 'p',
  splitType: 'y',
  participants: 'q',
  splitData: 'D',
  category: 'g',
  date: 'z',
  notes: 'o',
  // payer
  memberId: 'b',
  paise: 'v',
  // settlement
  from: 'f',
  to: 'x',
  method: 'h',
  ref: 'w',
  note: 'N',
  // recurring template
  rule: 'R',
  freq: 'F',
  interval: 'I',
  dayOfMonth: 'M',
  weekday: 'W',
  startDate: 'S',
  endDate: 'E',
  lastGeneratedAt: 'L',
  active: 'A',
});

/** Short key -> long key, built once and checked for collisions. */
const INVERSE_KEY_MAP = buildInverseKeyMap(KEY_MAP);

/** Keys whose value is a free-form map (member ids as keys) and must not be walked. */
const OPAQUE_KEYS = new Set(['splitData']);

/** Keys that must never be copied from a payload onto an object. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Escape marker for a key that would otherwise be mistaken for a short code. */
const ESCAPE = '~';

const GROUP_TYPES = new Set(['trip', 'home', 'event', 'other']);
// Mirrors SPLIT_TYPES in split.js; duplicated deliberately so this module has
// no dependency beyond money.js.
const SPLIT_TYPES = new Set(['equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized']);
const SETTLEMENT_METHODS = new Set(['upi', 'cash', 'other']);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

/** Per-collection caps, applied on both encode and decode. */
const LIMITS = Object.freeze({
  members: 200,
  expenses: 2000,
  settlements: 2000,
  recurring: 100,
  participants: 200,
  payers: 50,
  opaqueDepth: 6,
  opaqueEntries: 400,
  text: {
    id: 64,
    name: 120,
    emoji: 12,
    stamp: 40,
    description: 200,
    category: 60,
    notes: 2000,
    ref: 64,
    upi: 120,
  },
});

/**
 * Encode a group as a compact, URL-safe token.
 * @param {object} group a group as described in ARCHITECTURE.md (`store.js`)
 * @returns {Promise<string>} token beginning with a version character
 * @throws {Error} if `group` is not a group, or the payload exceeds 512 KB
 */
export async function encodeGroup(group) {
  const packed = shortenKeys(normalizeGroup(group));
  const bytes = new TextEncoder().encode(JSON.stringify(packed));

  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('This group is too large to share as a link (over 512 KB).');
  }

  if (typeof globalThis.CompressionStream === 'function') {
    const deflated = await deflateRaw(bytes);
    return TOKEN_DEFLATED + bytesToBase64Url(deflated);
  }
  return TOKEN_PLAIN + bytesToBase64Url(bytes);
}

/**
 * Decode a token produced by {@link encodeGroup}.
 * @param {string} token
 * @returns {Promise<object>} a freshly built, fully validated group
 * @throws {Error} on a malformed, truncated, oversized or non-group payload
 */
export async function decodeGroup(token) {
  if (typeof token !== 'string') throw new Error('Share token must be a string.');

  const trimmed = token.trim();
  if (trimmed.length < 2) throw new Error('Share token is empty.');
  if (trimmed.length > MAX_TOKEN_CHARS) throw new Error('Share data is too large (over 512 KB).');

  const version = trimmed[0];
  if (version !== TOKEN_DEFLATED && version !== TOKEN_PLAIN) {
    throw new Error(`Unsupported share link version "${version}".`);
  }

  let bytes = base64UrlToBytes(trimmed.slice(1));
  if (version === TOKEN_DEFLATED) bytes = await inflateRaw(bytes);
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Share data is too large (over 512 KB).');
  }

  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Share link is damaged (not valid text).');
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Share link is damaged (not valid data).');
  }

  return normalizeGroup(expandKeys(parsed));
}

/**
 * Build the full share URL for a group: `<origin><path>#g=<token>`.
 * Any existing query string or fragment on `baseUrl` is dropped.
 * @param {object} group
 * @param {string} [baseUrl] defaults to the current page URL when one exists
 * @returns {Promise<string>}
 */
export async function buildShareUrl(group, baseUrl) {
  const token = await encodeGroup(group);
  const base = resolveBase(baseUrl);
  if (base === '') return `#g=${token}`;

  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname}#g=${token}`;
  } catch {
    // Relative or non-absolute base: strip fragment and query by hand.
    return `${base.split('#')[0].split('?')[0]}#g=${token}`;
  }
}

/**
 * Read a `#g=` token out of a URL and decode it.
 * @param {string} [href] defaults to the current page URL when one exists
 * @returns {Promise<object|null>} the group, or null when the URL carries no token
 * @throws {Error} when a token IS present but cannot be decoded, so the caller
 *   can show the reason rather than silently ignoring a broken link
 */
export async function readShareUrl(href) {
  const target = typeof href === 'string' && href !== '' ? href : resolveBase();
  const token = extractToken(target);
  if (token === null) return null;
  return decodeGroup(token);
}

/* ------------------------------------------------------------------ *
 * URL helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} [baseUrl]
 * @returns {string} the caller's base, the page URL, or ''
 */
function resolveBase(baseUrl) {
  if (typeof baseUrl === 'string' && baseUrl !== '') return baseUrl;
  const loc = globalThis.location;
  return loc && typeof loc.href === 'string' ? loc.href : '';
}

/**
 * Pull the `g` parameter out of a URL fragment.
 * Tolerates hash routes such as `#/g/abc?g=<token>`.
 * @param {string} href
 * @returns {string|null}
 */
function extractToken(href) {
  const hashAt = href.indexOf('#');
  if (hashAt === -1) return null;

  const fragment = href.slice(hashAt + 1);
  const direct = new URLSearchParams(fragment).get('g');
  if (direct) return direct;

  const queryAt = fragment.indexOf('?');
  if (queryAt === -1) return null;
  return new URLSearchParams(fragment.slice(queryAt + 1)).get('g') || null;
}

/* ------------------------------------------------------------------ *
 * Key shortening
 * ------------------------------------------------------------------ */

/**
 * @param {Record<string, string>} map
 * @returns {Record<string, string>} short -> long
 */
function buildInverseKeyMap(map) {
  const inverse = Object.create(null);
  for (const [long, short] of Object.entries(map)) {
    if (inverse[short] !== undefined) {
      throw new Error(`share.js key map collision: "${short}" is used twice`);
    }
    inverse[short] = long;
  }
  return Object.freeze(inverse);
}

/**
 * @param {string} key
 * @returns {string} the short code, or an escaped copy of an unmapped key that
 *   would otherwise decode as a short code
 */
function toShortKey(key) {
  const short = KEY_MAP[key];
  if (short !== undefined) return short;
  if (key.startsWith(ESCAPE) || INVERSE_KEY_MAP[key] !== undefined) return ESCAPE + key;
  return key;
}

/**
 * @param {string} key
 * @returns {string} the original key
 */
function toLongKey(key) {
  if (key.startsWith(ESCAPE)) return key.slice(1);
  const long = INVERSE_KEY_MAP[key];
  return long === undefined ? key : long;
}

/**
 * Recursively rewrite object keys to their short codes.
 * @param {unknown} value
 * @returns {unknown}
 */
function shortenKeys(value) {
  if (Array.isArray(value)) return value.map(shortenKeys);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) continue;
    out[toShortKey(key)] = OPAQUE_KEYS.has(key) ? val : shortenKeys(val);
  }
  return out;
}

/**
 * Inverse of {@link shortenKeys}.
 * @param {unknown} value
 * @returns {unknown}
 */
function expandKeys(value) {
  if (Array.isArray(value)) return value.map(expandKeys);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const long = toLongKey(key);
    if (BLOCKED_KEYS.has(long)) continue;
    out[long] = OPAQUE_KEYS.has(long) ? val : expandKeys(val);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation / coercion
 * ------------------------------------------------------------------ */

/**
 * Rebuild a group from untrusted input, field by field.
 * Used on both encode and decode so a round trip is exactly symmetric.
 * @param {unknown} raw
 * @returns {object}
 * @throws {Error} when the value is not shaped like a group
 */
function normalizeGroup(raw) {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.members)) {
    throw new Error('Not a group: expected an object with a name and a members array.');
  }

  const group = {
    id: text(raw.id, LIMITS.text.id),
    name: text(raw.name, LIMITS.text.name),
    emoji: text(raw.emoji, LIMITS.text.emoji),
    type: GROUP_TYPES.has(raw.type) ? raw.type : 'other',
    createdAt: text(raw.createdAt, LIMITS.text.stamp),
    members: objects(raw.members, LIMITS.members).map(normalizeMember).filter((m) => m.id !== ''),
    expenses: objects(raw.expenses, LIMITS.expenses).map(normalizeExpense),
    settlements: objects(raw.settlements, LIMITS.settlements).map(normalizeSettlement),
  };

  // `recurring` is optional; only carry the key when the source really had it.
  if (Array.isArray(raw.recurring)) {
    group.recurring = objects(raw.recurring, LIMITS.recurring).map(normalizeRecurring);
  }
  return group;
}

/**
 * @param {object} raw
 * @returns {{id: string, name: string, upi: string|null, colorIndex: number}}
 */
function normalizeMember(raw) {
  return {
    id: text(raw.id, LIMITS.text.id),
    name: text(raw.name, LIMITS.text.name),
    upi: typeof raw.upi === 'string' && raw.upi !== '' ? text(raw.upi, LIMITS.text.upi) : null,
    colorIndex: integer(raw.colorIndex, 0, 0, 999),
  };
}

/**
 * @param {object} raw
 * @returns {object} an expense with every contracted field present
 */
function normalizeExpense(raw) {
  return {
    id: text(raw.id, LIMITS.text.id),
    description: text(raw.description, LIMITS.text.description),
    amount: paise(raw.amount),
    paidBy: objects(raw.paidBy, LIMITS.payers).map((p) => ({
      memberId: text(p.memberId, LIMITS.text.id),
      paise: paise(p.paise),
    })),
    splitType: SPLIT_TYPES.has(raw.splitType) ? raw.splitType : 'equal',
    participants: strings(raw.participants, LIMITS.participants, LIMITS.text.id),
    splitData: cloneOpaque(raw.splitData, 0),
    category: text(raw.category, LIMITS.text.category),
    date: text(raw.date, LIMITS.text.stamp),
    notes: text(raw.notes, LIMITS.text.notes),
    createdAt: text(raw.createdAt, LIMITS.text.stamp),
  };
}

/**
 * @param {object} raw
 * @returns {object} a settlement with every contracted field present
 */
function normalizeSettlement(raw) {
  return {
    id: text(raw.id, LIMITS.text.id),
    from: text(raw.from, LIMITS.text.id),
    to: text(raw.to, LIMITS.text.id),
    paise: paise(raw.paise),
    date: text(raw.date, LIMITS.text.stamp),
    method: SETTLEMENT_METHODS.has(raw.method) ? raw.method : 'other',
    ref: text(raw.ref, LIMITS.text.ref),
    note: text(raw.note, LIMITS.text.notes),
  };
}

/**
 * A recurring template as consumed by `recurring.js`.
 * @param {object} raw
 * @returns {object}
 */
function normalizeRecurring(raw) {
  const rawRule = isPlainObject(raw.rule) ? raw.rule : raw;
  const template = {
    id: text(raw.id, LIMITS.text.id),
    description: text(raw.description, LIMITS.text.description),
    amount: paise(raw.amount),
    paidBy: objects(raw.paidBy, LIMITS.payers).map((p) => ({
      memberId: text(p.memberId, LIMITS.text.id),
      paise: paise(p.paise),
    })),
    splitType: SPLIT_TYPES.has(raw.splitType) ? raw.splitType : 'equal',
    participants: strings(raw.participants, LIMITS.participants, LIMITS.text.id),
    splitData: cloneOpaque(raw.splitData, 0),
    category: text(raw.category, LIMITS.text.category),
    notes: text(raw.notes, LIMITS.text.notes),
    active: raw.active !== false,
    rule: {
      freq: FREQUENCIES.has(rawRule.freq) ? rawRule.freq : 'monthly',
      interval: integer(rawRule.interval, 1, 1, 366),
      startDate: text(rawRule.startDate, LIMITS.text.stamp),
    },
  };

  if (rawRule.dayOfMonth !== undefined && rawRule.dayOfMonth !== null) {
    template.rule.dayOfMonth = integer(rawRule.dayOfMonth, 1, 1, 31);
  }
  if (rawRule.weekday !== undefined && rawRule.weekday !== null) {
    template.rule.weekday = integer(rawRule.weekday, 0, 0, 6);
  }
  if (typeof rawRule.endDate === 'string' && rawRule.endDate !== '') {
    template.rule.endDate = text(rawRule.endDate, LIMITS.text.stamp);
  }
  if (typeof raw.lastGeneratedAt === 'string' && raw.lastGeneratedAt !== '') {
    template.lastGeneratedAt = text(raw.lastGeneratedAt, LIMITS.text.stamp);
  }
  return template;
}

/**
 * Copy a free-form map (splitData) without walking it into anything dangerous.
 * @param {unknown} value
 * @param {number} depth
 * @returns {object|unknown}
 */
function cloneOpaque(value, depth) {
  if (Array.isArray(value)) {
    if (depth >= LIMITS.opaqueDepth) return [];
    return value.slice(0, LIMITS.opaqueEntries).map((v) => cloneOpaque(v, depth + 1));
  }
  if (isPlainObject(value)) {
    if (depth >= LIMITS.opaqueDepth) return {};
    const out = {};
    let kept = 0;
    for (const [key, val] of Object.entries(value)) {
      if (BLOCKED_KEYS.has(key)) continue;
      if (kept >= LIMITS.opaqueEntries) break;
      out[key.slice(0, LIMITS.text.id)] = cloneOpaque(val, depth + 1);
      kept += 1;
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, LIMITS.text.description);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (depth === 0) return {}; // splitData itself is always an object
  return null;
}

/**
 * @param {unknown} value
 * @param {number} max characters
 * @returns {string}
 */
function text(value, max) {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return '';
}

/**
 * @param {unknown} value
 * @returns {number} integer paise inside ±MAX_PAISE
 */
function paise(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.round(value);
  if (n > MAX_PAISE) return MAX_PAISE;
  if (n < -MAX_PAISE) return -MAX_PAISE;
  return n;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function integer(value, fallback, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * @param {unknown} value
 * @param {number} max entries
 * @returns {object[]} only the plain objects, capped
 */
function objects(value, max) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).filter(isPlainObject);
}

/**
 * @param {unknown} value
 * @param {number} max entries
 * @param {number} maxLength characters per entry
 * @returns {string[]}
 */
function strings(value, max, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .filter((v) => typeof v === 'string' && v !== '')
    .map((v) => v.slice(0, maxLength));
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null, non-array object
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Compression + base64url
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(bytes) {
  return pumpThrough(
    new globalThis.CompressionStream('deflate-raw'),
    bytes,
    MAX_PAYLOAD_BYTES * 2,
    'Share data is too large (over 512 KB).',
  );
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 * @throws {Error} when the stream is truncated, corrupt, or expands past the cap
 */
async function inflateRaw(bytes) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed share links.');
  }
  try {
    return await pumpThrough(
      new globalThis.DecompressionStream('deflate-raw'),
      bytes,
      MAX_PAYLOAD_BYTES,
      'Share data is too large (over 512 KB).',
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Share data is too large')) throw err;
    throw new Error('Share link is damaged or incomplete.');
  }
}

/**
 * Push `bytes` through a transform stream and collect the result, refusing to
 * buffer more than `limit` bytes.
 * @param {{readable: ReadableStream, writable: WritableStream}} transform
 * @param {Uint8Array} bytes
 * @param {number} limit
 * @param {string} tooLargeMessage
 * @returns {Promise<Uint8Array>}
 */
async function pumpThrough(transform, bytes, limit, tooLargeMessage) {
  const writer = transform.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  written.catch(() => {}); // the rejection is surfaced by the await below

  const reader = transform.readable.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(tooLargeMessage);
    }
    chunks.push(value);
  }
  await written;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} base64url, unpadded
 */
function bytesToBase64Url(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {string} value base64url, padded or not
 * @returns {Uint8Array}
 * @throws {Error} on characters outside the base64url alphabet or a bad length
 */
function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Share link contains characters that are not part of a token.');
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Share link is damaged (truncated token).');
  }

  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
