# Architecture & Module Contract

This document is the **binding interface contract**. Every module implements exactly
the exports described here. Nothing imports anything not listed here.

## Principles

1. **Zero build step.** Plain ES modules (`<script type="module">`), plain CSS.
   GitHub Pages serves the repository root as-is. No bundler, no transpiler,
   no `node_modules` at runtime.
2. **Zero runtime dependencies.** No CDN, no framework. Everything — including the
   QR encoder — is written in this repository. The app works fully offline.
3. **Integer paise.** All monetary values are integers representing paise
   (1 rupee = 100 paise). Floating point never touches money. A value of `12345`
   means ₹123.45.
4. **Pure core, thin UI.** Everything in `src/core/` is a pure function of its inputs
   with no DOM access, no `localStorage`, and no globals (except `store.js`, which owns
   persistence). This makes the whole engine unit-testable under `node --test`.
5. **Local-first.** The browser is the only database. No server, no account, no
   telemetry. Data leaves the device only when the user explicitly exports or shares.

## Directory layout

```
index.html              Single entry point (app shell)
manifest.webmanifest    PWA manifest
sw.js                   Service worker (offline cache)
assets/styles.css       Design system + all component styles
assets/icons/           App icons, favicon
src/core/               Pure engine (unit-tested, no DOM)
src/ui/                 DOM rendering & event wiring
tests/                  node --test suites for src/core
docs/                   Architecture, algorithm notes, UPI notes
```

---

## `src/core/money.js`

Money is an integer number of paise. Never a float, never a string, in the domain model.

```js
/** Max supported magnitude in paise (₹10 crore). Guards against overflow/absurd input. */
export const MAX_PAISE = 1_000_000_000_00;

/** Parse user input ("1,234.5", "₹1234.50", "1234") -> integer paise.
 *  Throws RangeError on invalid/negative/over-max input. Accepts at most 2 decimals. */
export function parseAmount(input)

/** 123456 -> "1,234.56"  (Indian digit grouping: 1,23,45,678.90) */
export function formatPaise(paise, { symbol = false, sign = false } = {})

/** 123456 -> "₹1,234.56" */
export function formatINR(paise, opts)

/** Split `total` paise into `n` parts as evenly as possible.
 *  Returns an integer array of length n summing EXACTLY to total.
 *  Remainder paise are distributed to the first `remainder` parts (deterministic). */
export function splitEvenly(total, n)

/** Allocate `total` paise proportionally to `weights` (array of non-negative numbers).
 *  Uses the LARGEST REMAINDER (Hamilton) method so the result sums EXACTLY to total.
 *  Ties broken by lowest index for determinism. Throws if all weights are zero. */
export function allocateByWeights(total, weights)

/** Sum an array of paise with overflow guard. */
export function sum(values)

/** Clamp helper used by the UI for slider/percent inputs. */
export function clamp(n, lo, hi)
```

**Invariants (tested):** `sum(splitEvenly(t, n)) === t` and
`sum(allocateByWeights(t, w)) === t` for all valid inputs, including negative totals
(refunds) and totals smaller than `n`.

---

## `src/core/split.js`

Turns one expense into per-member shares. Every strategy returns exact integer paise
summing to the expense total.

```js
/** @typedef {{memberId: string, paise: number}} Share */

export const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized'];

/** Compute shares for an expense.
 * @param {object} expense - { amount, splitType, participants: string[], splitData }
 * @returns {Share[]} sums exactly to expense.amount
 *
 * splitData shape by splitType:
 *   equal      : ignored (may be {})
 *   exact      : { [memberId]: paise }        must sum to amount
 *   percent    : { [memberId]: number }       percentages, must sum to 100 (±0.01 tolerance)
 *   shares     : { [memberId]: number }       integer weights, e.g. {a:2, b:1}
 *   adjustment : { [memberId]: paise }        per-head extra/less; the rest split equally
 *   itemized   : { items: [{ name, amount, participants: string[] }],
 *                  tax: paise, tip: paise, discount: paise }
 *                Each item splits equally among its participants; tax/tip/discount are
 *                allocated proportionally to each member's pre-tax subtotal.
 */
export function computeShares(expense)

/** Validate splitData for a split type before it is committed.
 * @returns {{ok: true} | {ok: false, error: string}} */
export function validateSplit(expense)

/** Human label, e.g. "Split equally", "By shares (2:1:1)" */
export function describeSplit(expense, membersById)
```

---

## `src/core/balances.js`

```js
/** @typedef {{memberId: string, net: number}} Balance  // net > 0 => is owed; net < 0 => owes */

/** Net balance per member across expenses AND recorded settlements.
 *  Returns Balance[] sorted by net descending. Members with zero net are included.
 *  Invariant (tested): the sum of all `net` values is exactly 0. */
export function computeBalances(group)

/** Full pairwise ledger: who owes whom, before simplification.
 *  @returns {Array<{from: string, to: string, paise: number}>} (paise > 0) */
export function computePairwiseDebts(group)

/** Per-member totals for the insights view.
 *  @returns {Map<string, {paid: number, owed: number, net: number, expenseCount: number}>} */
export function memberTotals(group)

/** Category -> total paise, for the spend breakdown chart. */
export function categoryTotals(group)

/** Month ("2026-09") -> total paise, chronologically ascending. */
export function monthlyTotals(group)
```

---

## `src/core/settle.js`

```js
/** @typedef {{from: string, to: string, paise: number}} Transfer */

/** Minimise the NUMBER of transfers needed to zero out all balances.
 *  - n <= 12 members: exact — partitions members into zero-sum subgroups via
 *    memoised bitmask DP, then settles each subgroup greedily. Provably minimal
 *    transfer count for the partition found.
 *  - n > 12: greedy max-debtor/max-creditor matching (at most n-1 transfers).
 *
 *  Invariants (tested):
 *    - every transfer amount is a positive integer
 *    - applying all transfers zeroes every balance exactly
 *    - transfer count <= (number of members with a non-zero balance) - 1
 *  @param {Balance[]} balances
 *  @returns {Transfer[]} */
export function minimiseTransfers(balances)

/** Direct (unsimplified) settlement: pay back exactly whom you borrowed from.
 *  @returns {Transfer[]} */
export function directTransfers(group)

/** Resulting balances after applying `transfers` — used to verify a plan. */
export function applyTransfers(balances, transfers)
```

---

## `src/core/upi.js`

The UPI-native layer. Builds NPCI-compliant deep links.

```js
/** Strict VPA check: `user@handle`. Returns {ok, error?, normalized?}. */
export function validateVpa(vpa)

/** Build a `upi://pay?...` intent URL.
 * @param {object} p - { pa, pn, am (paise), tn, tr, mc, cu }
 *   pa  payee VPA (required)      pn  payee name (required)
 *   am  amount in PAISE -> serialised as rupees with exactly 2 decimals
 *   tn  transaction note (<= 50 chars, sanitised)
 *   tr  transaction ref id (<= 35 chars, alphanumeric)
 * All values are percent-encoded with encodeURIComponent.
 * @returns {string} */
export function buildUpiUri(p)

/** App-specific links so the UI can offer "Open in GPay / PhonePe / Paytm". */
export function buildAppLinks(p)   // -> [{ id, name, url, color }]

/** Parse a upi:// URI back into params (used by the import/paste flow). */
export function parseUpiUri(uri)

/** Deterministic, UPI-safe transaction reference for a settlement. */
export function settlementRef(groupId, transfer)

/** Known Indian UPI handles for the autocomplete datalist. */
export const UPI_HANDLES
```

---

## `src/core/qr.js`

A complete QR Code encoder written from the ISO/IEC 18004 specification. No dependency.

```js
/** Encode text as a QR matrix.
 * @param {string} text
 * @param {{ecc?: 'L'|'M'|'Q'|'H', minVersion?: number, maxVersion?: number}} opts
 * @returns {{size: number, modules: boolean[][], version: number, ecc: string}}
 * Throws if the text cannot fit in maxVersion. */
export function encodeQR(text, opts)

/** Render a matrix to a standalone SVG string (crisp at any size, theme-aware). */
export function toSvg(qr, { moduleSize = 4, margin = 4, dark = '#000', light = '#fff' } = {})

/** Draw a matrix onto a canvas element (used for PNG download). */
export function toCanvas(qr, canvas, opts)
```

Must correctly implement: byte-mode (and numeric/alphanumeric optimisation),
version selection 1–40, Reed–Solomon error correction over GF(256), block
interleaving, all 8 data masks with penalty-score selection, and format/version
information bits.

---

## `src/core/store.js`

Single source of truth. Owns `localStorage`. Everything else is pure.

```js
/** Shape:
 * { version: 3,
 *   groups: Group[],
 *   activeGroupId: string|null,
 *   settings: { theme, simplifyDebts, currencySymbol, myMemberId, defaultUpi } }
 *
 * Group: { id, name, emoji, type: 'trip'|'home'|'event'|'other', createdAt,
 *          members: Member[], expenses: Expense[], settlements: Settlement[] }
 * Member: { id, name, upi: string|null, colorIndex }
 * Expense: { id, description, amount, paidBy: Payer[], splitType, participants,
 *            splitData, category, date, notes, createdAt }
 *   Payer: { memberId, paise }   // supports MULTIPLE payers on one expense
 * Settlement: { id, from, to, paise, date, method: 'upi'|'cash'|'other', ref, note }
 */

export function getState()
export function subscribe(fn)          // -> unsubscribe
export function dispatch(action)       // { type, ...payload }
export function getActiveGroup()
export function loadFromStorage()
export function saveToStorage()
export function migrate(raw)           // upgrades older persisted schemas
export function resetAll()
```

Actions: `group/create`, `group/update`, `group/delete`, `group/select`,
`member/add`, `member/update`, `member/remove`, `expense/add`, `expense/update`,
`expense/delete`, `settlement/add`, `settlement/delete`, `settings/update`,
`state/import`, `state/replace`.

---

## `src/core/share.js`

```js
/** Group -> compact URL-safe string (JSON -> key-shortened -> DEFLATE via
 *  CompressionStream when available -> base64url). Async. */
export async function encodeGroup(group)

/** Inverse of encodeGroup. Throws on malformed/oversized payloads. */
export async function decodeGroup(token)

/** Full share URL: `<origin><path>#g=<token>` */
export async function buildShareUrl(group, baseUrl)

/** Read `#g=` from a URL, returning the decoded group or null. */
export async function readShareUrl(href)
```

---

## `src/core/csv.js`

```js
export function expensesToCsv(group)      // -> string with CRLF, RFC-4180 quoting
export function settlementsToCsv(group)
export function balancesToCsv(group)
export function parseCsv(text)            // -> string[][]
export function csvToExpenses(text, group)// -> {expenses, errors}
```

---

## `src/core/recurring.js`

```js
/** Expand recurring templates into concrete expenses due on or before `asOf`. */
export function dueOccurrences(group, asOf)
export function nextDueDate(rule, from)   // rule: {freq:'weekly'|'monthly', interval, dayOfMonth?}
```

---

## `src/ui/*`

Each view exports `render(container, props)` and wires its own events via
delegation. `src/ui/app.js` owns the router (hash-based), subscribes to the store,
and re-renders the active view. No view reaches into another view's DOM.

Views: `dashboard.js`, `group.js`, `expenses.js`, `expense-form.js`, `balances.js`,
`settle.js`, `members.js`, `insights.js`, `settings.js`, plus shared
`components.js` (modal, toast, sheet, empty state, avatar, chart primitives).

## Testing

`node --test tests/` runs every core suite. The UI is verified by a headless
smoke test (`tests/smoke.test.js`) that parses `index.html`, checks every module
resolves, and asserts no module in `src/core/` references `document` or `window`
except `store.js`, `share.js`, and `qr.js`.
