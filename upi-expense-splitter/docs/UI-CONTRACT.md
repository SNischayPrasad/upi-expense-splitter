# UI Contract

Binding interface for everything under `src/ui/` and `assets/styles.css`.
Views never touch each other's DOM and never import each other.

## Rendering model

There is no virtual DOM and no framework. `src/ui/app.js` owns a single
`<main id="view">` element. On every state change it calls the active view's
`render(container, ctx)`, which replaces `container`'s children.

```js
/** Every view module exports exactly this. */
export function render(container, ctx) {}

/** ctx (built by app.js, passed to every view):
 * {
 *   state,          // the full store state
 *   group,          // the active group, or null
 *   route,          // { name, params }
 *   dispatch,       // store.dispatch
 *   navigate(hash), // router push
 *   toast(msg, kind),
 *   openModal(opts), closeModal(),
 *   openSheet(opts), closeSheet(),
 *   confirm(opts),  // -> Promise<boolean>
 * }
 */
```

Event wiring inside a view uses **delegation on `container`** so re-rendering
never leaks listeners. Use `data-action="name"` attributes and a single
`container.addEventListener('click', ...)`.

## Routes (hash-based)

| Hash | View module | Purpose |
|---|---|---|
| `#/` | `dashboard.js` | All groups, overall net position |
| `#/g/:id` | `group.js` | Group overview (tabs shell) |
| `#/g/:id/expenses` | `expenses.js` | Expense list + filters |
| `#/g/:id/expense/new`, `#/g/:id/expense/:eid` | `expense-form.js` | Add / edit expense |
| `#/g/:id/balances` | `balances.js` | Who owes whom |
| `#/g/:id/settle` | `settle.js` | Settlement plan + UPI pay |
| `#/g/:id/members` | `members.js` | Members & their UPI IDs |
| `#/g/:id/insights` | `insights.js` | Charts & stats |
| `#/settings` | `settings.js` | Theme, data, import/export |

Unknown routes fall back to `#/`.

## `src/ui/components.js`

Shared primitives. All return **DOM nodes** (not HTML strings) unless the name
ends in `Html`. All are XSS-safe: user text goes through `el()`'s text argument
or `escapeHtml()`, never raw interpolation into `innerHTML`.

```js
/** Hyperscript: el('div.card#id', {attrs}, ...children) — children may be
 *  nodes, strings (escaped as text), or nullish (skipped). */
export function el(selector, props, ...children)

/** Escape a string for safe innerHTML interpolation. */
export function escapeHtml(s)

/** <svg> icon by name from an internal path table. Names used by the app:
 *  plus, users, receipt, scale, handshake, chart, settings, back, close, check,
 *  trash, edit, share, download, upload, qr, copy, search, filter, sun, moon,
 *  home, plane, party, wallet, sparkle, arrow-right, alert, info, link, sort. */
export function icon(name, size = 20)

/** Circular member avatar with initials and a deterministic colour. */
export function avatar(member, size = 36)

/** Page/section header with optional back button and actions. */
export function pageHeader({ title, subtitle, back, actions })

/** Empty state block. */
export function emptyState({ icon: iconName, title, body, action })

/** Toast — auto-dismisses. kind: 'success' | 'error' | 'info'. */
export function toast(message, kind = 'info')

/** Modal dialog built on <dialog>. Returns { close }. */
export function modal({ title, body, actions, onClose })

/** Bottom sheet (mobile-first). Returns { close }. */
export function sheet({ title, body, onClose })

/** Promise-based confirm dialog. */
export function confirmDialog({ title, body, confirmLabel, danger })

/** Labelled form field wrapper. */
export function field({ label, input, hint, error })

/** Segmented control. onChange(value). */
export function segmented({ options, value, onChange, name })

/** Money input bound to core/money parseAmount; exposes .valuePaise via getter. */
export function amountInput({ value, onInput, autofocus })

/** Chip / tag. */
export function chip({ label, active, onClick, color })

/** Horizontal bar chart from [{label, value, color}] — inline SVG, no deps. */
export function barChart(data, { height, formatValue })

/** Donut chart from [{label, value, color}] — inline SVG with a centre total. */
export function donutChart(data, { size, formatValue, centerLabel })

/** Sparkline / line chart over [{label, value}]. */
export function lineChart(data, { width, height, formatValue })

/** Copy text to the clipboard, with a fallback for insecure contexts. */
export function copyToClipboard(text)

/** Relative date label: "Today", "Yesterday", "12 Sep". */
export function formatDate(iso, { relative = true } = {})
```

## `assets/styles.css`

A single stylesheet using CSS custom properties. **Required token names** (other
modules reference these):

```
--bg --bg-elevated --bg-sunken --surface --surface-hover --border --border-strong
--text --text-muted --text-faint
--accent --accent-hover --accent-soft --accent-contrast
--positive --positive-soft --negative --negative-soft --warning --warning-soft
--radius-sm --radius --radius-lg --radius-full
--shadow-sm --shadow --shadow-lg
--space-1 … --space-8
--font --font-mono
--member-1 … --member-8   (avatar palette)
```

Light palette on `:root`; dark overrides under both
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`
**and** `:root[data-theme="dark"]`, so the in-app theme toggle wins in both
directions.

**Required classes** used by views: `.card`, `.btn`, `.btn-primary`,
`.btn-ghost`, `.btn-danger`, `.btn-icon`, `.input`, `.select`, `.field`,
`.row`, `.stack`, `.cluster`, `.list`, `.list-item`, `.badge`, `.chip`,
`.tabs`, `.tab`, `.avatar`, `.money`, `.money-pos`, `.money-neg`, `.muted`,
`.page-header`, `.empty`, `.toast`, `.sheet`, `.skeleton`, `.fab`, `.stat`,
`.segmented`, `.divider`, `.qr-frame`.

Mobile-first; breakpoint at `640px` and `960px`. Respects
`prefers-reduced-motion`. Every interactive element has a visible
`:focus-visible` ring. Minimum tap target 44×44px.
