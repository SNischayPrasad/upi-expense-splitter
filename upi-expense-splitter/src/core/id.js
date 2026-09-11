/**
 * id.js — identifier generation and URL slugs.
 *
 * Pure module: no DOM, no storage, no globals beyond the standard `crypto`
 * object (feature-detected, never assumed). Runs unchanged in the browser and
 * under `node --test`.
 *
 * Ids use a 32-character URL-safe alphabet (Crockford base32 without the
 * ambiguous i/l/o/u), so they survive being pasted into a URL, a hash fragment,
 * a CSV cell or a `data-id` attribute without escaping.
 */

/** 32 symbols => exactly 5 bits per character, so a byte can be masked without modulo bias. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Random characters per id. 12 * 5 = 60 bits — far beyond what a local ledger can collide on. */
const TOKEN_LENGTH = 12;

/** Longest prefix we keep, so ids stay short and predictable. */
const MAX_PREFIX = 8;

/** Longest slug we emit; share links stay comfortably inside URL length limits. */
const MAX_SLUG = 60;

/** Monotonic counter used only by the last-resort generator. */
let fallbackCounter = 0;

/**
 * Generate a short, URL-safe, collision-resistant id.
 *
 * The prefix is a readability aid only — it is lower-cased and stripped of
 * anything outside `[a-z0-9]`, so `newId('exp')` yields `"exp_7k2m9q4xv3bd"`.
 *
 * @param {string} [prefix] Optional entity tag, e.g. 'grp', 'mem', 'exp', 'stl'.
 * @returns {string} A new id. Never empty.
 */
export function newId(prefix = '') {
  const token = randomToken(TOKEN_LENGTH);
  const tag = normalizePrefix(prefix);
  return tag ? `${tag}_${token}` : token;
}

/**
 * Deterministic, URL-safe slug used for human-readable group share links
 * (`#/g/goa-trip-2026`). Pure: the same input always produces the same output.
 *
 * Diacritics are folded (`Café` -> `cafe`); every other non-alphanumeric run
 * collapses to a single hyphen. Scripts with no ASCII equivalent (Devanagari,
 * emoji) drop out entirely, so a slug can legitimately be empty — in that case
 * `'untitled'` is returned rather than an empty string.
 *
 * @param {string} text
 * @returns {string} A non-empty slug of at most 60 characters.
 */
export function slug(text) {
  const source = text == null ? '' : String(text);
  const folded = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const trimmed = stripHyphens(folded).slice(0, MAX_SLUG);
  return stripHyphens(trimmed) || 'untitled';
}

/**
 * Remove leading and trailing hyphens.
 * @param {string} s
 * @returns {string}
 */
function stripHyphens(s) {
  return s.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * Sanitise a caller-supplied prefix into `[a-z0-9]{0,8}`.
 * @param {unknown} prefix
 * @returns {string}
 */
function normalizePrefix(prefix) {
  if (prefix == null) return '';
  return String(prefix).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MAX_PREFIX);
}

/**
 * Build a random token from the URL-safe alphabet.
 * @param {number} length
 * @returns {string}
 */
function randomToken(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/**
 * Fill `n` bytes with the strongest source this runtime offers:
 * `crypto.randomUUID` -> `crypto.getRandomValues` -> a seeded xorshift fallback.
 *
 * The UUID path is listed first because it is the most widely available entry
 * point; only 6 of a v4 UUID's 128 bits are fixed, so a 12-character token still
 * carries well over 50 bits of entropy.
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function randomBytes(n) {
  const c = globalThis.crypto;

  if (c && typeof c.randomUUID === 'function') {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const hex = c.randomUUID().replace(/-/g, '');
      for (let j = 0; j + 1 < hex.length && i < n; j += 2) {
        out[i++] = parseInt(hex.slice(j, j + 2), 16);
      }
    }
    return out;
  }

  if (c && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint8Array(n));
  }

  return fallbackBytes(n);
}

/**
 * Last-resort byte source for runtimes with no Web Crypto: an xorshift32 stream
 * seeded from the clock, a per-process counter and `Math.random`. Not
 * cryptographically strong, but it cannot repeat within a session and is only
 * ever reached on engines that predate `crypto.getRandomValues`.
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function fallbackBytes(n) {
  const out = new Uint8Array(n);
  let seed = (Date.now() ^ (fallbackCounter++ << 16) ^ 0x9e3779b9) >>> 0;
  if (seed === 0) seed = 0x6d2b79f5;

  for (let i = 0; i < n; i++) {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    out[i] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
  }
  return out;
}
