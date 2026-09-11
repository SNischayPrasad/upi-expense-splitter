/**
 * components.js — shared DOM primitives for every view.
 *
 * Everything here returns real DOM nodes (never HTML strings) so user-supplied
 * text can never be interpolated into markup. The only escaping helper,
 * `escapeHtml`, exists for the rare case where a view really does need to build
 * a string (e.g. an SVG payload handed to a download).
 *
 * This module may touch the DOM freely — but only inside functions, never at
 * module scope, so that `import('./components.js')` also succeeds under
 * `node --test` where there is no `document`.
 *
 * Money formatting is always delegated to ../core/money.js.
 */

import { parseAmount, formatINR, formatPaise, clamp } from '../core/money.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Avatar / chart palette. Mirrors `--member-1 … --member-8` in assets/styles.css. */
const MEMBER_COLORS = [
  'var(--member-1)',
  'var(--member-2)',
  'var(--member-3)',
  'var(--member-4)',
  'var(--member-5)',
  'var(--member-6)',
  'var(--member-7)',
  'var(--member-8)',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let uidCounter = 0;

/** Unique DOM id generator (labels, aria-describedby, dialog titles). */
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * el() — the hyperscript backbone
 * ------------------------------------------------------------------ */

/** Props that must be assigned as DOM *properties*, not attributes. */
const PROPERTY_KEYS = new Set([
  'value',
  'checked',
  'indeterminate',
  'selected',
  'disabled',
  'readOnly',
  'multiple',
  'textContent',
  'autofocus',
]);

/** Props whose `true` value must also land as an attribute (CSS/selectors rely on it). */
const BOOLEAN_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'open', 'autofocus', 'multiple']);

const selectorCache = new Map();

/**
 * Parse a hyperscript selector such as `button.btn.btn-primary#save`.
 * @param {string} selector
 * @returns {{tag: string, id: string, classes: string[]}}
 */
function parseSelector(selector) {
  const key = String(selector == null ? '' : selector).trim();
  const cached = selectorCache.get(key);
  if (cached) return cached;

  let tag = 'div';
  let rest = key;
  const tagMatch = key.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    tag = tagMatch[0];
    rest = key.slice(tagMatch[0].length);
  }

  const classes = [];
  let id = '';
  const tokens = rest.matchAll(/([.#])([^.#\s]+)/g);
  for (const [, kind, name] of tokens) {
    if (kind === '.') classes.push(name);
    else id = name;
  }

  const parsed = { tag, id, classes };
  selectorCache.set(key, parsed);
  return parsed;
}

/** `ariaLabel` -> `aria-label`, `tabIndex` -> `tabindex`, `htmlFor` -> `for`. */
function attrName(key) {
  if (key === 'htmlFor') return 'for';
  if (key === 'className') return 'class';
  if (/[A-Z]/.test(key) && /^(aria|data)[A-Z]/.test(key)) {
    return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }
  if (key === 'tabIndex') return 'tabindex';
  if (key === 'readOnly') return 'readonly';
  if (key === 'inputMode') return 'inputmode';
  if (key === 'autoComplete') return 'autocomplete';
  if (key === 'maxLength') return 'maxlength';
  if (key === 'minLength') return 'minlength';
  return key;
}

/** `backgroundColor` -> `background-color`; custom properties pass through. */
function styleName(key) {
  if (key.startsWith('--')) return key;
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Normalise a class value: string, array, or `{name: truthy}` map.
 * @param {string|string[]|Record<string, unknown>|null|undefined} value
 * @returns {string[]}
 */
function normaliseClasses(value) {
  if (!value) return [];
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(normaliseClasses);
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, on]) => Boolean(on))
      .map(([name]) => name);
  }
  return [];
}

/**
 * Attach an `{eventName: handler}` map. A handler may be a function or a
 * `[handler, options]` pair (for `{passive: true}`, `{once: true}`, …).
 * @param {Element} node
 * @param {Record<string, Function|[Function, object]>} handlers
 */
function bindEvents(node, handlers) {
  for (const [name, handler] of Object.entries(handlers || {})) {
    if (!handler) continue;
    if (Array.isArray(handler)) node.addEventListener(name, handler[0], handler[1]);
    else node.addEventListener(name, handler);
  }
}

/**
 * Append children of any supported shape to a parent node.
 * Strings and numbers become TEXT nodes (never markup), arrays are flattened,
 * and `null` / `undefined` / `false` are skipped.
 * @param {Node} parent
 * @param {unknown} child
 */
function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

/**
 * Hyperscript element factory — the backbone of every view.
 *
 * @example
 * el('button.btn.btn-primary#save',
 *    { type: 'button', dataset: { action: 'save' }, on: { click: onSave } },
 *    icon('check'), ' Save');
 *
 * @param {string} selector `tag.class.class#id`; the tag defaults to `div`.
 * @param {object|null} [props] Attributes plus the special keys:
 *   - `class` / `className`: string, array, or `{name: truthy}` map
 *   - `dataset`: `{key: value}` written to `data-*`
 *   - `style`: `{prop: value}` object (camelCase or `--custom`) or a string
 *   - `on`: `{event: handler}` or `{event: [handler, options]}`
 *   - `ref`: callback invoked with the finished node
 *   - any other key: `true` sets a bare attribute, `false`/`null`/`undefined`
 *     omits it, everything else is stringified.
 * @param {...unknown} children Nodes, strings (appended as text, so XSS-safe),
 *   numbers, nested arrays, or nullish values (skipped).
 * @returns {HTMLElement}
 */
export function el(selector, props, ...children) {
  const { tag, id, classes } = parseSelector(selector);
  const node = document.createElement(tag);

  if (id) node.id = id;
  if (classes.length) node.classList.add(...classes);

  if (props && typeof props === 'object') {
    // `type` must be applied before `value` for <input> to accept it.
    if (props.type !== undefined && props.type !== null) node.setAttribute('type', String(props.type));

    for (const [key, value] of Object.entries(props)) {
      if (key === 'type') continue;

      if (key === 'class' || key === 'className') {
        const list = normaliseClasses(value);
        if (list.length) node.classList.add(...list);
        continue;
      }
      if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(value || {})) {
          if (dv === null || dv === undefined || dv === false) continue;
          node.dataset[dk] = String(dv);
        }
        continue;
      }
      if (key === 'style') {
        if (typeof value === 'string') node.setAttribute('style', value);
        else if (value && typeof value === 'object') {
          for (const [sk, sv] of Object.entries(value)) {
            if (sv === null || sv === undefined || sv === false) continue;
            node.style.setProperty(styleName(sk), String(sv));
          }
        }
        continue;
      }
      if (key === 'on') {
        bindEvents(node, value);
        continue;
      }
      if (key === 'ref') {
        continue; // applied last, once the node is fully built
      }
      if (/^on[A-Z]/.test(key) && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }

      if (value === null || value === undefined || value === false) continue;

      if (PROPERTY_KEYS.has(key)) {
        node[key] = value === true ? true : value;
        if (value === true && BOOLEAN_ATTRS.has(attrName(key))) node.setAttribute(attrName(key), '');
        continue;
      }

      if (value === true) node.setAttribute(attrName(key), '');
      else node.setAttribute(attrName(key), String(value));
    }
  }

  for (const child of children) appendChild(node, child);

  if (props && typeof props.ref === 'function') props.ref(node);
  return node;
}

/**
 * Escape a string for safe interpolation into an HTML/SVG string.
 * Prefer `el()` with text children; use this only when a string is unavoidable.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create an SVG-namespaced element. Attribute names are used verbatim so
 * camelCase SVG attributes (`viewBox`, `preserveAspectRatio`) survive.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children
 * @returns {SVGElement}
 */
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) appendChild(node, child);
  return node;
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

/** @returns {{tag: 'path', d: string}} */
const p = (d) => ({ tag: 'path', d });
/** @returns {{tag: 'circle'}} */
const c = (cx, cy, r) => ({ tag: 'circle', cx, cy, r });
/** @returns {{tag: 'rect'}} */
const rect = (x, y, width, height, rx) => ({ tag: 'rect', x, y, width, height, rx });

/**
 * A ring of radial spokes (gear teeth / sun rays) around 12,12.
 * @param {number} inner
 * @param {number} outer
 * @returns {Array<{tag: 'path', d: string}>}
 */
function spokes(inner, outer) {
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const x1 = (12 + inner * Math.cos(a)).toFixed(2);
    const y1 = (12 + inner * Math.sin(a)).toFixed(2);
    const x2 = (12 + outer * Math.cos(a)).toFixed(2);
    const y2 = (12 + outer * Math.sin(a)).toFixed(2);
    out.push(p(`M${x1} ${y1}L${x2} ${y2}`));
  }
  return out;
}

/**
 * Icon geometry, drawn on a 24×24 grid as stroke-only shapes.
 * A zero-length segment (`h.01`) renders as a dot thanks to the round line cap.
 */
const ICONS = {
  plus: [p('M12 5v14'), p('M5 12h14')],
  minus: [p('M5 12h14')],
  users: [
    c(9.5, 8, 3.2),
    p('M3.4 20.4v-1.3a4.3 4.3 0 0 1 4.3-4.3h3.6a4.3 4.3 0 0 1 4.3 4.3v1.3'),
    p('M16.6 5.2a3.2 3.2 0 0 1 0 5.7'),
    p('M18.3 15a4.3 4.3 0 0 1 2.3 3.8v1.6'),
  ],
  user: [c(12, 8, 3.6), p('M4.8 20.4v-1a4.4 4.4 0 0 1 4.4-4.4h5.6a4.4 4.4 0 0 1 4.4 4.4v1')],
  receipt: [
    p('M6 21.2V4a1.2 1.2 0 0 1 1.2-1.2h9.6A1.2 1.2 0 0 1 18 4v17.2l-3-1.7-3 1.7-3-1.7z'),
    p('M9.5 8h5'),
    p('M9.5 12h5'),
  ],
  scale: [
    c(12, 4.6, 1.5),
    p('M12 6.1V20'),
    p('M7.5 20h9'),
    p('M5 9 12 7l7 2'),
    p('M5 9 2.3 14.6a3 3 0 0 0 5.4 0z'),
    p('M19 9l2.7 5.6a3 3 0 0 1-5.4 0z'),
  ],
  handshake: [
    p('M2.5 12.2 5.6 9.1l3.6 3.6'),
    p('M21.5 12.2 18.4 9.1l-3.6 3.6'),
    p('M9.2 12.7 12 9.9l2.8 2.8L12 15.5z'),
    p('M5.6 9.1 8.2 6.5h2.6'),
    p('M18.4 9.1 15.8 6.5h-2.6'),
  ],
  chart: [p('M3.6 3v17.4H21'), p('M8 20.4v-6.2'), p('M12.6 20.4v-10.4'), p('M17.2 20.4v-4')],
  settings: [c(12, 12, 3.4), c(12, 12, 6.2), ...spokes(6.2, 7.9)],
  back: [p('M19.5 12H4.5'), p('M10.5 18 4.5 12l6-6')],
  close: [p('M18.5 5.5 5.5 18.5'), p('M5.5 5.5 18.5 18.5')],
  check: [p('M20 6.5 9.5 17 4 11.5')],
  trash: [
    p('M3.8 6.5h16.4'),
    p('M9 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 4.8v1.7'),
    p('M6.2 6.5 7 19.3a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l.8-12.8'),
    p('M10.2 10.5v6'),
    p('M13.8 10.5v6'),
  ],
  edit: [p('M4 20h4.2L20 8.2a2.3 2.3 0 0 0-3.2-3.2L5 16.8z'), p('M15.4 6.4l3.2 3.2')],
  share: [c(18, 5.5, 2.6), c(6, 12, 2.6), c(18, 18.5, 2.6), p('M8.3 10.8 15.7 6.7'), p('M8.3 13.2 15.7 17.3')],
  download: [p('M12 3.5v11.8'), p('M7.6 10.9 12 15.3l4.4-4.4'), p('M4.5 19.5h15')],
  upload: [p('M12 15.3V3.7'), p('M7.6 8.1 12 3.7l4.4 4.4'), p('M4.5 19.5h15')],
  qr: [
    rect(3.2, 3.2, 7, 7, 1.6),
    rect(13.8, 3.2, 7, 7, 1.6),
    rect(3.2, 13.8, 7, 7, 1.6),
    p('M6.7 6.7h.01'),
    p('M17.3 6.7h.01'),
    p('M6.7 17.3h.01'),
    p('M13.8 13.8h3'),
    p('M20.8 13.8v3'),
    p('M13.8 20.8h3.2'),
    p('M17.3 17.4h.01'),
    p('M20.8 20.8h.01'),
  ],
  copy: [
    rect(8.8, 8.8, 11.7, 11.7, 2.2),
    p('M5.4 15.2H4.7A2.2 2.2 0 0 1 2.5 13V5.7a2.2 2.2 0 0 1 2.2-2.2H13a2.2 2.2 0 0 1 2.2 2.2v.7'),
  ],
  search: [c(10.8, 10.8, 6.6), p('M15.7 15.7 21 21')],
  filter: [p('M3.5 5.3h17l-6.6 7.9v5.3l-3.8 2v-7.3z')],
  sun: [c(12, 12, 4.2), ...spokes(6.6, 8.8)],
  moon: [p('M20.8 14.6A8.6 8.6 0 0 1 9.4 3.2 8.6 8.6 0 1 0 20.8 14.6z')],
  home: [
    p('M3.4 10.4 12 3.6l8.6 6.8'),
    p('M5.6 9v10.6a1.6 1.6 0 0 0 1.6 1.6h9.6a1.6 1.6 0 0 0 1.6-1.6V9'),
    p('M9.8 21.2v-5.6a2.2 2.2 0 0 1 4.4 0v5.6'),
  ],
  plane: [p('M21.6 2.6 2.6 10.1l8 3.3 3.3 8z'), p('M21.6 2.6 10.6 13.4')],
  party: [
    p('M2.8 21.2 7.6 8.5l7.6 7.6z'),
    p('M15.5 3v2.2'),
    p('M19.6 7.1h2.2'),
    p('M18.3 4.3 19.9 2.7'),
    p('M18.6 11.9l1.9 1'),
    p('M13.4 6.3 14.4 4.4'),
  ],
  wallet: [
    rect(2.8, 5.8, 18.4, 13, 2.6),
    p('M20.6 10.4h-3.1a2.1 2.1 0 0 0 0 4.2h3.1'),
    p('M17.4 12.5h.01'),
  ],
  sparkle: [
    p('M12 3.2 13.9 8.3 19 10.2 13.9 12.1 12 17.2 10.1 12.1 5 10.2 10.1 8.3z'),
    p('M18.4 15.2 19.1 17 20.9 17.7 19.1 18.4 18.4 20.2 17.7 18.4 15.9 17.7 17.7 17z'),
  ],
  'arrow-right': [p('M4.5 12h14'), p('M12.8 6.3 18.5 12l-5.7 5.7')],
  alert: [
    p('M10.3 4 2.7 17.4A2 2 0 0 0 4.4 20.4h15.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z'),
    p('M12 9.6v4.2'),
    p('M12 17.2h.01'),
  ],
  info: [c(12, 12, 8.8), p('M12 11.4v5'), p('M12 8h.01')],
  link: [
    p('M10.4 13.6a4.2 4.2 0 0 0 6 0l2.6-2.6a4.2 4.2 0 1 0-6-6l-1.5 1.5'),
    p('M13.6 10.4a4.2 4.2 0 0 0-6 0L5 13a4.2 4.2 0 1 0 6 6l1.5-1.5'),
  ],
  sort: [p('M7 4.6v14.8'), p('M3.6 8 7 4.6 10.4 8'), p('M17 19.4V4.6'), p('M13.6 16 17 19.4 20.4 16')],
  calendar: [rect(3.2, 5, 17.6, 16, 2.4), p('M3.2 9.8h17.6'), p('M8 3.2v3.4'), p('M16 3.2v3.4')],
  tag: [
    p('M11.6 2.8H4.8a2 2 0 0 0-2 2v6.8a2 2 0 0 0 .6 1.4l7.6 7.6a2 2 0 0 0 2.8 0l6.8-6.8a2 2 0 0 0 0-2.8L13 3.4a2 2 0 0 0-1.4-.6z'),
    p('M7.6 7.6h.01'),
  ],
  'chevron-right': [p('M9 5.5 15.5 12 9 18.5')],
  'chevron-down': [p('M5.5 9 12 15.5 18.5 9')],
  more: [p('M12 5.2h.01'), p('M12 12h.01'), p('M12 18.8h.01')],
};

/**
 * Build an inline `<svg>` icon from the internal 24×24 path table.
 * Icons are decorative by default (`aria-hidden`); give the surrounding
 * control its own `aria-label`.
 * @param {string} name One of: plus, minus, users, user, receipt, scale,
 *   handshake, chart, settings, back, close, check, trash, edit, share,
 *   download, upload, qr, copy, search, filter, sun, moon, home, plane, party,
 *   wallet, sparkle, arrow-right, alert, info, link, sort, calendar, tag,
 *   chevron-right, chevron-down, more.
 * @param {number} [size=20] Rendered width and height in CSS pixels.
 * @returns {SVGElement}
 */
export function icon(name, size = 20) {
  const key = String(name || '');
  const shapes = ICONS[key] || ICONS.info;
  const node = svg('svg', {
    class: `icon icon-${key || 'unknown'}`,
    'data-icon': key,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const shape of shapes) {
    const { tag, ...attrs } = shape;
    node.appendChild(svg(tag, attrs));
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Avatar
 * ------------------------------------------------------------------ */

/** Stable 32-bit FNV-1a hash, used to pick a palette slot from a member id. */
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Palette slot (0…7) for a member: honours an explicit `colorIndex`, otherwise
 * hashes the id so the same member always gets the same colour.
 * @param {{id?: string, name?: string, colorIndex?: number}} member
 * @returns {number}
 */
function memberColorSlot(member) {
  const idx = member && member.colorIndex;
  if (Number.isInteger(idx)) return ((idx % MEMBER_COLORS.length) + MEMBER_COLORS.length) % MEMBER_COLORS.length;
  const seed = String((member && (member.id || member.name)) || '');
  return hashString(seed) % MEMBER_COLORS.length;
}

/**
 * Initials: first letter of the first two words, uppercased. Falls back to `?`.
 * @param {string} name
 * @returns {string}
 */
function initialsOf(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]);
  return letters.join('').toUpperCase();
}

/**
 * Circular member avatar: initials on a deterministic colour from the
 * `--member-1 … --member-8` palette.
 * @param {{id?: string, name?: string, colorIndex?: number}} member
 * @param {number} [size=36] Diameter in CSS pixels.
 * @returns {HTMLElement} A `<span class="avatar">` exposing the accessible name.
 */
export function avatar(member, size = 36) {
  const name = (member && member.name) || 'Unknown';
  const slot = memberColorSlot(member || {});
  return el(
    'span.avatar',
    {
      role: 'img',
      'aria-label': name,
      title: name,
      dataset: { memberId: (member && member.id) || '', color: String(slot + 1) },
      style: {
        '--avatar-size': `${size}px`,
        '--avatar-bg': MEMBER_COLORS[slot],
        width: `${size}px`,
        height: `${size}px`,
        backgroundColor: MEMBER_COLORS[slot],
        color: 'var(--avatar-fg, #fff)',
        fontSize: `${Math.max(10, Math.round(size * 0.4))}px`,
      },
    },
    el('span.avatar-initials', { 'aria-hidden': 'true' }, initialsOf(name)),
  );
}

/* ------------------------------------------------------------------ *
 * Layout blocks
 * ------------------------------------------------------------------ */

/**
 * Page or section header with an optional back control and trailing actions.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {string|Function|true|{href?: string, onClick?: Function, label?: string}} [opts.back]
 *   A hash string renders a link, a function renders a button, `true` uses
 *   `history.back()`.
 * @param {Node|Node[]} [opts.actions] Buttons rendered on the trailing edge.
 * @returns {HTMLElement}
 */
export function pageHeader({ title, subtitle, back, actions } = {}) {
  const header = el('header.page-header');

  if (back) {
    const spec = typeof back === 'object' && !Array.isArray(back) ? back : {};
    const label = spec.label || 'Back';
    const href = typeof back === 'string' ? back : spec.href;
    const onClick = typeof back === 'function' ? back : spec.onClick;

    if (href) {
      header.appendChild(
        el('a.btn.btn-icon.btn-ghost.page-back', { href, 'aria-label': label, title: label }, icon('back', 20)),
      );
    } else {
      header.appendChild(
        el(
          'button.btn.btn-icon.btn-ghost.page-back',
          {
            type: 'button',
            'aria-label': label,
            title: label,
            on: { click: onClick || (() => history.back()) },
          },
          icon('back', 20),
        ),
      );
    }
  }

  header.appendChild(
    el(
      'div.page-header-text',
      null,
      el('h1.page-title', null, title || ''),
      subtitle ? el('p.page-subtitle.muted', null, subtitle) : null,
    ),
  );

  const actionNodes = toNodes(actions);
  if (actionNodes.length) header.appendChild(el('div.cluster.page-header-actions', null, actionNodes));

  return header;
}

/**
 * Empty-state block for lists with nothing in them yet.
 * @param {object} opts
 * @param {string} [opts.icon] Icon name for the illustration.
 * @param {string} opts.title
 * @param {string} [opts.body] Supporting sentence.
 * @param {Node|Node[]} [opts.action] Primary call to action.
 * @returns {HTMLElement}
 */
export function emptyState({ icon: iconName, title, body, action } = {}) {
  return el(
    'div.empty',
    null,
    iconName ? el('div.empty-icon', { 'aria-hidden': 'true' }, icon(iconName, 40)) : null,
    title ? el('h2.empty-title', null, title) : null,
    body ? el('p.empty-body.muted', null, body) : null,
    action ? el('div.empty-action', null, toNodes(action)) : null,
  );
}

/**
 * Coerce a body/action value (node, string, array, nullish) into a node array.
 * @param {unknown} value
 * @returns {Node[]}
 */
function toNodes(value) {
  if (value === null || value === undefined || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(toNodes);
  if (value instanceof Node) return [value];
  return [document.createTextNode(String(value))];
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

const TOAST_ICONS = { success: 'check', error: 'alert', info: 'info' };
const TOAST_TTL_MS = 3500;

/** Lazily create the single polite live region that hosts all toasts. */
function toastRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = el('div.toast-region#toast-region', {
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    });
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Show a transient message in the shared live region. Toasts stack, announce
 * themselves politely to screen readers, pause their timer on hover/focus, and
 * auto-dismiss after ~3.5 s.
 * @param {string} message
 * @param {'success'|'error'|'info'} [kind='info']
 * @returns {{node: HTMLElement, dismiss: () => void}}
 */
export function toast(message, kind = 'info') {
  const type = TOAST_ICONS[kind] ? kind : 'info';
  const region = toastRegion();

  let timer = 0;
  let dismissed = false;

  const node = el(
    `div.toast.toast-${type}`,
    { dataset: { kind: type } },
    el('span.toast-icon', { 'aria-hidden': 'true' }, icon(TOAST_ICONS[type], 18)),
    el('span.toast-message', null, String(message === null || message === undefined ? '' : message)),
    el(
      'button.btn.btn-icon.btn-ghost.toast-close',
      { type: 'button', 'aria-label': 'Dismiss notification', on: { click: () => dismiss() } },
      icon('close', 16),
    ),
  );

  function remove() {
    if (!node.isConnected) return;
    node.remove();
    if (region.childElementCount === 0 && region.isConnected) region.remove();
  }

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      remove();
      return;
    }
    node.classList.add('toast-leaving');
    setTimeout(remove, 220);
  }

  function start() {
    clearTimeout(timer);
    timer = setTimeout(dismiss, TOAST_TTL_MS);
  }

  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', start);
  node.addEventListener('focusin', () => clearTimeout(timer));
  node.addEventListener('focusout', start);

  region.appendChild(node);
  start();

  return { node, dismiss };
}

/* ------------------------------------------------------------------ *
 * Dialogs: modal, sheet, confirm
 * ------------------------------------------------------------------ */

/**
 * Shared `<dialog>` plumbing: native focus trap, Escape to close, backdrop
 * click to close, focus restored to the previously focused element, and the
 * element removed from the DOM once closed.
 * @param {object} opts
 * @param {string} opts.className Root class (`modal` or `sheet`).
 * @param {(dialog: HTMLDialogElement, titleId: string) => Node[]} opts.build
 * @param {(returnValue: string) => void} [opts.onClose]
 * @returns {{element: HTMLDialogElement, close: (returnValue?: string) => void}}
 */
function createDialog({ className, build, onClose }) {
  const titleId = uid('dialog-title');
  const dialog = /** @type {HTMLDialogElement} */ (
    el(`dialog.${className}`, { 'aria-labelledby': titleId })
  );

  for (const child of build(dialog, titleId)) dialog.appendChild(child);

  const previouslyFocused = document.activeElement;
  let closed = false;

  // Only treat a click as a backdrop click when it both started and ended on
  // the dialog element itself — a text selection dragged outside must not close.
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => {
    pressedBackdrop = event.target === dialog;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressedBackdrop) close('dismiss');
    pressedBackdrop = false;
  });

  dialog.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    dialog.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus({ preventScroll: true });
    }
    if (typeof onClose === 'function') onClose(dialog.returnValue || '');
  });

  /**
   * @param {string} [returnValue]
   */
  function close(returnValue = '') {
    if (closed || !dialog.isConnected) return;
    if (typeof dialog.close === 'function') dialog.close(returnValue);
    else dialog.dispatchEvent(new Event('close'));
  }

  dialog.addEventListener('click', (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-dialog-close]') : null;
    if (trigger && dialog.contains(trigger)) {
      event.preventDefault();
      close(trigger.getAttribute('data-dialog-close') || 'dismiss');
    }
  });

  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');

  const autofocus = dialog.querySelector('[autofocus]');
  if (autofocus && typeof autofocus.focus === 'function') autofocus.focus({ preventScroll: true });

  return { element: dialog, close };
}

/**
 * Centred modal dialog built on the native `<dialog>` element.
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|Node[]|string} opts.body
 * @param {Node|Node[]} [opts.actions] Footer buttons, in reading order.
 * @param {(returnValue: string) => void} [opts.onClose]
 * @returns {{element: HTMLDialogElement, close: (returnValue?: string) => void}}
 */
export function modal({ title, body, actions, onClose } = {}) {
  return createDialog({
    className: 'modal',
    onClose,
    build: (dialog, titleId) => {
      const actionNodes = toNodes(actions);
      return [
        el(
          'header.modal-header',
          null,
          el('h2.modal-title', { id: titleId }, title || ''),
          el(
            'button.btn.btn-icon.btn-ghost.modal-close',
            { type: 'button', 'aria-label': 'Close', dataset: { dialogClose: 'dismiss' } },
            icon('close', 18),
          ),
        ),
        el('div.modal-body', null, toNodes(body)),
        actionNodes.length ? el('footer.modal-actions.cluster', null, actionNodes) : null,
      ].filter(Boolean);
    },
  });
}

/**
 * Bottom sheet (mobile-first) built on the native `<dialog>` element.
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|Node[]|string} opts.body
 * @param {(returnValue: string) => void} [opts.onClose]
 * @returns {{element: HTMLDialogElement, close: (returnValue?: string) => void}}
 */
export function sheet({ title, body, onClose } = {}) {
  return createDialog({
    className: 'sheet',
    onClose,
    build: (dialog, titleId) => [
      el('div.sheet-handle', { 'aria-hidden': 'true' }),
      el(
        'header.sheet-header',
        null,
        el('h2.sheet-title', { id: titleId }, title || ''),
        el(
          'button.btn.btn-icon.btn-ghost.sheet-close',
          { type: 'button', 'aria-label': 'Close', dataset: { dialogClose: 'dismiss' } },
          icon('close', 18),
        ),
      ),
      el('div.sheet-body', null, toNodes(body)),
    ],
  });
}

/**
 * Promise-based replacement for `window.confirm`.
 * Resolves `true` only when the confirm button is pressed; Escape, the close
 * button, the backdrop and Cancel all resolve `false`.
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|Node[]|string} [opts.body]
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean} [opts.danger=false] Styles the confirm button as destructive
 *   and moves the initial focus to Cancel.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const handle = createDialog({
      className: 'modal modal-confirm',
      onClose: (returnValue) => settle(returnValue === 'confirm'),
      build: (dialog, titleId) => [
        el(
          'header.modal-header',
          null,
          el('h2.modal-title', { id: titleId }, title || 'Are you sure?'),
        ),
        el('div.modal-body', null, toNodes(body)),
        el(
          'footer.modal-actions.cluster',
          null,
          el(
            'button.btn.btn-ghost',
            {
              type: 'button',
              autofocus: danger || undefined,
              on: { click: () => handle.close('cancel') },
            },
            cancelLabel,
          ),
          el(
            `button.btn.${danger ? 'btn-danger' : 'btn-primary'}`,
            {
              type: 'button',
              autofocus: danger ? undefined : true,
              on: { click: () => handle.close('confirm') },
            },
            confirmLabel,
          ),
        ),
      ],
    });
  });
}

/* ------------------------------------------------------------------ *
 * Form primitives
 * ------------------------------------------------------------------ */

/**
 * Find the focusable control inside a wrapper (or the wrapper itself).
 * @param {Node} node
 * @returns {HTMLElement|null}
 */
function controlOf(node) {
  if (!(node instanceof Element)) return null;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) return /** @type {HTMLElement} */ (node);
  return node.querySelector('input, select, textarea');
}

/**
 * Labelled form field wrapper. Wires `for`/`id`, `aria-describedby` for the
 * hint and `aria-invalid` + `role="alert"` for the error.
 * @param {object} opts
 * @param {string} opts.label
 * @param {Node} opts.input The control (or a wrapper containing one).
 * @param {string} [opts.hint]
 * @param {string} [opts.error]
 * @returns {HTMLElement}
 */
export function field({ label, input, hint, error } = {}) {
  const wrap = el('div.field');
  const control = controlOf(input);
  const describedBy = [];

  if (control && !control.id) control.id = uid('field');

  if (label) {
    wrap.appendChild(
      el('label.field-label', control && control.id ? { htmlFor: control.id } : null, label),
    );
  }
  if (input) wrap.appendChild(input);

  if (hint) {
    const hintId = uid('hint');
    describedBy.push(hintId);
    wrap.appendChild(el('p.field-hint.muted', { id: hintId }, hint));
  }
  if (error) {
    const errId = uid('error');
    describedBy.push(errId);
    wrap.appendChild(el('p.field-error', { id: errId, role: 'alert' }, error));
    if (control) control.setAttribute('aria-invalid', 'true');
    wrap.classList.add('field-invalid');
  } else if (control) {
    control.removeAttribute('aria-invalid');
  }

  if (control && describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '));
  return wrap;
}

/**
 * Segmented control backed by real radio inputs, so arrow-key navigation and
 * focus rings come from the platform.
 * @param {object} opts
 * @param {Array<string|{value: string, label?: string, icon?: string, disabled?: boolean}>} opts.options
 * @param {string} [opts.value] Currently selected value.
 * @param {(value: string) => void} [opts.onChange]
 * @param {string} [opts.name] Radio group name; generated when omitted.
 * @returns {HTMLElement} A `<div class="segmented">` with a `value` getter.
 */
export function segmented({ options = [], value, onChange, name } = {}) {
  const groupName = name || uid('segmented');
  const group = el('div.segmented', { role: 'group' });

  for (const raw of options) {
    const option = typeof raw === 'string' ? { value: raw, label: raw } : raw || {};
    const optionValue = String(option.value);
    const input = el('input.segmented-input', {
      type: 'radio',
      name: groupName,
      value: optionValue,
      checked: optionValue === String(value),
      disabled: option.disabled || undefined,
      on: {
        change: () => {
          if (typeof onChange === 'function') onChange(optionValue);
        },
      },
    });

    group.appendChild(
      el(
        'label.segmented-option',
        { dataset: { value: optionValue } },
        input,
        el(
          'span.segmented-label',
          null,
          option.icon ? icon(option.icon, 16) : null,
          option.label === undefined ? optionValue : option.label,
        ),
      ),
    );
  }

  Object.defineProperty(group, 'value', {
    get() {
      const checked = group.querySelector('input:checked');
      return checked ? checked.value : null;
    },
    set(next) {
      for (const input of group.querySelectorAll('input')) input.checked = input.value === String(next);
    },
  });

  return group;
}

/**
 * Money input bound to `parseAmount` from core/money.
 *
 * The returned wrapper exposes:
 *   - `valuePaise` — integer paise, or `null` while the field is empty/invalid
 *     (also settable: assigning paise re-renders the formatted text)
 *   - `input` — the underlying `<input>` element
 *   - `error` — the current validation message, or `''`
 *
 * Validation runs on every keystroke but never throws: an empty field is
 * treated as "not yet entered" rather than an error, and partial input such as
 * `"12."` stays valid while typing.
 *
 * @param {object} [opts]
 * @param {number|string} [opts.value] Initial value — integer paise or raw text.
 * @param {(paise: number|null, meta: {valid: boolean, error: string, raw: string, input: HTMLInputElement}) => void} [opts.onInput]
 * @param {boolean} [opts.autofocus]
 * @param {string} [opts.placeholder='0.00']
 * @param {string} [opts.name]
 * @returns {HTMLElement}
 */
export function amountInput({ value, onInput, autofocus, placeholder = '0.00', name } = {}) {
  const errorId = uid('amount-error');
  const initial =
    typeof value === 'number' && Number.isFinite(value) ? formatPaise(value) : value === undefined || value === null ? '' : String(value);

  const input = /** @type {HTMLInputElement} */ (
    el('input.input.amount-field', {
      type: 'text',
      inputMode: 'decimal',
      autoComplete: 'off',
      spellcheck: 'false',
      name: name || undefined,
      placeholder,
      value: initial,
      autofocus: autofocus || undefined,
      'aria-describedby': errorId,
      'aria-label': 'Amount in rupees',
    })
  );

  const errorNode = el('p.field-error.amount-error', { id: errorId, role: 'alert', hidden: true });

  const wrap = el(
    'div.amount-input',
    null,
    el('span.amount-prefix', { 'aria-hidden': 'true' }, '₹'),
    input,
    errorNode,
  );

  let paise = null;
  let message = '';

  /**
   * Re-validate the raw text and reflect the result in the DOM.
   * @param {boolean} notify Whether to invoke the `onInput` callback.
   */
  function validate(notify) {
    const raw = input.value;
    if (raw.trim() === '') {
      paise = null;
      message = '';
    } else {
      try {
        paise = parseAmount(raw);
        message = '';
      } catch (err) {
        paise = null;
        message = err instanceof Error ? err.message : 'Enter a valid amount';
      }
    }

    const invalid = message !== '';
    wrap.classList.toggle('amount-invalid', invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    errorNode.textContent = message;
    errorNode.hidden = !invalid;

    if (notify && typeof onInput === 'function') {
      onInput(paise, { valid: !invalid, error: message, raw, input });
    }
  }

  input.addEventListener('input', () => validate(true));
  input.addEventListener('blur', () => {
    // Canonicalise once the user leaves the field: "1234.5" -> "1,234.50".
    if (paise !== null) input.value = formatPaise(paise);
    validate(false);
  });

  Object.defineProperty(wrap, 'valuePaise', {
    get: () => paise,
    set(next) {
      input.value = typeof next === 'number' && Number.isFinite(next) ? formatPaise(next) : '';
      validate(false);
    },
  });
  Object.defineProperty(wrap, 'input', { get: () => input });
  Object.defineProperty(wrap, 'error', { get: () => message });

  validate(false);
  return wrap;
}

/**
 * Chip / tag. Renders a `<button>` when `onClick` is given (with
 * `aria-pressed`), otherwise a static `<span>`.
 * @param {object} opts
 * @param {string} opts.label
 * @param {boolean} [opts.active=false]
 * @param {(event: MouseEvent) => void} [opts.onClick]
 * @param {string} [opts.color] CSS colour exposed as `--chip-color` plus a dot.
 * @param {string} [opts.icon] Leading icon name.
 * @returns {HTMLElement}
 */
export function chip({ label, active = false, onClick, color, icon: iconName } = {}) {
  const children = [
    color ? el('span.chip-dot', { 'aria-hidden': 'true', style: { backgroundColor: color } }) : null,
    iconName ? icon(iconName, 14) : null,
    el('span.chip-label', null, label === undefined || label === null ? '' : label),
  ];
  const props = {
    class: { 'chip-active': Boolean(active), 'chip-colored': Boolean(color) },
    style: color ? { '--chip-color': color } : null,
  };

  if (typeof onClick === 'function') {
    return el(
      'button.chip',
      { ...props, type: 'button', 'aria-pressed': active ? 'true' : 'false', on: { click: onClick } },
      children,
    );
  }
  return el('span.chip', props, children);
}

/* ------------------------------------------------------------------ *
 * Charts — inline SVG, zero dependencies
 * ------------------------------------------------------------------ */

/** Default money formatter shared by every chart. */
const defaultFormatValue = (paise) => formatINR(paise);

/**
 * Shorten a label so SVG text cannot overflow its column (SVG has no
 * text-overflow). Uses an ellipsis so truncation is visible.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build a responsive chart root: intrinsic pixel size for the aspect ratio,
 * CSS width 100% so it fills its card.
 * @param {number} width
 * @param {number} height
 * @param {string} className
 * @param {string} label Accessible summary.
 * @returns {SVGElement}
 */
function chartRoot(width, height, className, label) {
  return svg('svg', {
    class: className,
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': label,
    preserveAspectRatio: 'xMidYMid meet',
    style: 'width:100%;height:auto;overflow:visible',
  });
}

/**
 * Friendly placeholder used whenever a chart has nothing to draw.
 * @param {number} width
 * @param {number} height
 * @param {string} message
 * @param {string} className
 * @returns {SVGElement}
 */
function chartEmpty(width, height, message, className) {
  const root = chartRoot(width, height, `${className} chart-empty`, message);
  root.appendChild(
    svg('rect', {
      x: 1,
      y: 1,
      width: width - 2,
      height: height - 2,
      rx: 10,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1,
      'stroke-dasharray': '4 5',
      opacity: 0.25,
    }),
  );
  root.appendChild(
    svg(
      'text',
      {
        x: width / 2,
        y: height / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-size': 12,
        fill: 'currentColor',
        opacity: 0.6,
      },
      message,
    ),
  );
  return root;
}

/**
 * Normalise chart input into `{label, value, color}` records, dropping entries
 * without a finite value.
 * @param {Array<{label?: string, value?: number, color?: string}>} data
 * @returns {Array<{label: string, value: number, color: string|null}>}
 */
function normaliseSeries(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((d) => d && Number.isFinite(Number(d.value)))
    .map((d) => ({
      label: d.label === undefined || d.label === null ? '' : String(d.label),
      value: Number(d.value),
      color: d.color || null,
    }));
}

/**
 * Human summary used as the chart's `aria-label`.
 * @param {string} prefix
 * @param {Array<{label: string, value: number}>} series
 * @param {(v: number) => string} formatValue
 * @param {number} [max=8]
 * @returns {string}
 */
function seriesSummary(prefix, series, formatValue, max = 8) {
  const parts = series.slice(0, max).map((d) => `${d.label || 'Unlabelled'} ${formatValue(d.value)}`);
  if (series.length > max) parts.push(`and ${series.length - max} more`);
  return `${prefix}: ${parts.join('; ')}.`;
}

/**
 * Horizontal bar chart. Bars are drawn from a zero baseline, so negative values
 * (refunds, net balances) render to the left of it.
 * @param {Array<{label: string, value: number, color?: string}>} data
 * @param {object} [opts]
 * @param {number} [opts.height] Total SVG height; rows are distributed to fit.
 * @param {(paise: number) => string} [opts.formatValue]
 * @param {string} [opts.emptyMessage='Nothing to chart yet']
 * @returns {SVGElement}
 */
export function barChart(data, { height, formatValue = defaultFormatValue, emptyMessage = 'Nothing to chart yet' } = {}) {
  const series = normaliseSeries(data);
  const WIDTH = 320;
  const LABEL_W = 84;
  const VALUE_W = 76;

  if (!series.length) return chartEmpty(WIDTH, height || 120, emptyMessage, 'chart chart-bar');

  const rowHeight = height
    ? clamp(height / series.length, 18, 56)
    : 28;
  const totalHeight = Math.round(height || rowHeight * series.length + 8);
  const topPad = 4;

  const root = chartRoot(
    WIDTH,
    totalHeight,
    'chart chart-bar',
    seriesSummary('Bar chart', series, formatValue),
  );

  const maxValue = Math.max(...series.map((d) => d.value), 0);
  const minValue = Math.min(...series.map((d) => d.value), 0);
  const span = Math.max(maxValue - minValue, 1);
  const plotX = LABEL_W;
  const plotW = WIDTH - LABEL_W - VALUE_W;
  const zeroX = plotX + ((0 - minValue) / span) * plotW;

  // Baseline — only meaningful when the data straddles zero.
  root.appendChild(
    svg('line', {
      x1: zeroX,
      y1: topPad,
      x2: zeroX,
      y2: totalHeight - topPad,
      stroke: 'currentColor',
      'stroke-width': 1,
      opacity: 0.18,
    }),
  );

  series.forEach((d, i) => {
    const rowY = topPad + i * rowHeight;
    const centreY = rowY + rowHeight / 2;
    const barH = Math.min(12, Math.max(6, rowHeight - 14));
    const valueX = plotX + ((d.value - minValue) / span) * plotW;
    const x = Math.min(zeroX, valueX);
    const w = Math.max(Math.abs(valueX - zeroX), 2);

    const group = svg('g', { class: 'chart-bar-row' });
    group.appendChild(
      svg('title', {}, `${d.label || 'Unlabelled'}: ${formatValue(d.value)}`),
    );
    group.appendChild(
      svg('text', {
        x: LABEL_W - 8,
        y: centreY,
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
        'font-size': 11,
        fill: 'currentColor',
        opacity: 0.72,
      }, truncate(d.label, 13)),
    );
    group.appendChild(
      svg('rect', {
        x,
        y: centreY - barH / 2,
        width: w,
        height: barH,
        rx: Math.min(4, barH / 2),
        fill: d.color || 'var(--accent)',
      }),
    );
    group.appendChild(
      svg('text', {
        x: WIDTH,
        y: centreY,
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
        'font-size': 11,
        fill: 'currentColor',
      }, truncate(formatValue(d.value), 12)),
    );
    root.appendChild(group);
  });

  return root;
}

/**
 * Donut chart with a total in the centre. Slices are drawn as dashed strokes on
 * a single circle with `pathLength="100"`, so no arc trigonometry is involved
 * and a single 100% slice renders as a clean ring.
 * @param {Array<{label: string, value: number, color?: string}>} data
 * @param {object} [opts]
 * @param {number} [opts.size=180] Width and height in pixels.
 * @param {(paise: number) => string} [opts.formatValue]
 * @param {string} [opts.centerLabel] Caption under the centre total.
 * @param {string} [opts.emptyMessage='No spending yet']
 * @returns {SVGElement}
 */
export function donutChart(data, { size = 180, formatValue = defaultFormatValue, centerLabel, emptyMessage = 'No spending yet' } = {}) {
  const series = normaliseSeries(data).filter((d) => d.value > 0);
  const total = series.reduce((a, d) => a + d.value, 0);

  if (!series.length || total <= 0) return chartEmpty(size, size, emptyMessage, 'chart chart-donut');

  const label = `${seriesSummary('Donut chart', series, formatValue)} Total ${formatValue(total)}.`;
  const root = chartRoot(size, size, 'chart chart-donut', label);

  const cx = size / 2;
  const cy = size / 2;
  const thickness = Math.max(10, size * 0.16);
  const r = (size - thickness) / 2 - 1;

  root.appendChild(
    svg('circle', {
      cx,
      cy,
      r,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': thickness,
      opacity: 0.08,
    }),
  );

  const ring = svg('g', { transform: `rotate(-90 ${cx} ${cy})` });
  let offset = 0;
  series.forEach((d, i) => {
    const pct = (d.value / total) * 100;
    if (pct <= 0) return;
    const slice = svg('circle', {
      cx,
      cy,
      r,
      fill: 'none',
      stroke: d.color || MEMBER_COLORS[i % MEMBER_COLORS.length],
      'stroke-width': thickness,
      pathLength: 100,
      'stroke-dasharray': `${pct} ${Math.max(100 - pct, 0)}`,
      'stroke-dashoffset': -offset,
    });
    slice.appendChild(
      svg('title', {}, `${d.label || 'Unlabelled'}: ${formatValue(d.value)} (${pct.toFixed(1)}%)`),
    );
    ring.appendChild(slice);
    offset += pct;
  });
  root.appendChild(ring);

  const totalText = formatValue(total);
  // Shrink the centre text so long totals stay inside the hole.
  const totalFont = clamp((size * 0.9) / Math.max(totalText.length, 6), 10, size * 0.17);
  root.appendChild(
    svg('text', {
      x: cx,
      y: centerLabel ? cy - 4 : cy,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-size': totalFont.toFixed(1),
      'font-weight': 600,
      fill: 'currentColor',
      class: 'chart-donut-total',
    }, totalText),
  );
  if (centerLabel) {
    root.appendChild(
      svg('text', {
        x: cx,
        y: cy + totalFont * 0.85,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-size': clamp(size * 0.075, 9, 13).toFixed(1),
        fill: 'currentColor',
        opacity: 0.65,
        class: 'chart-donut-caption',
      }, truncate(centerLabel, 18)),
    );
  }

  return root;
}

/**
 * Line chart / sparkline over an ordered series (typically monthly totals).
 * X labels are thinned and rotated only as far as needed to avoid overlap.
 * @param {Array<{label: string, value: number}>} data
 * @param {object} [opts]
 * @param {number} [opts.width=320]
 * @param {number} [opts.height=120]
 * @param {(paise: number) => string} [opts.formatValue]
 * @param {string} [opts.color='var(--accent)']
 * @param {string} [opts.emptyMessage='Not enough history yet']
 * @returns {SVGElement}
 */
export function lineChart(data, {
  width = 320,
  height = 120,
  formatValue = defaultFormatValue,
  color = 'var(--accent)',
  emptyMessage = 'Not enough history yet',
} = {}) {
  const series = normaliseSeries(data);
  if (!series.length) return chartEmpty(width, height, emptyMessage, 'chart chart-line');

  const values = series.map((d) => d.value);
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values, 0);
  const span = Math.max(maxValue - minValue, 1);

  const LABEL_FONT = 9.5;
  const CHAR_W = 5.6;
  const longest = Math.max(...series.map((d) => truncate(d.label, 8).length), 1);
  const padLeft = 6;
  const padRight = 6;
  const padTop = 14;
  const innerW = width - padLeft - padRight;
  const slot = series.length > 1 ? innerW / (series.length - 1) : innerW;
  const rotate = longest * CHAR_W + 6 > slot;
  const padBottom = rotate ? 30 : 20;
  const innerH = height - padTop - padBottom;

  const root = chartRoot(
    width,
    height,
    'chart chart-line',
    seriesSummary('Line chart', series, formatValue, 12),
  );

  const xAt = (i) => (series.length === 1 ? padLeft + innerW / 2 : padLeft + (i / (series.length - 1)) * innerW);
  const yAt = (v) => padTop + innerH - ((v - minValue) / span) * innerH;

  // Baseline + top gridline, both theme-neutral.
  for (const [value, dash] of [[minValue, '0'], [maxValue, '3 4']]) {
    root.appendChild(
      svg('line', {
        x1: padLeft,
        y1: yAt(value),
        x2: width - padRight,
        y2: yAt(value),
        stroke: 'currentColor',
        'stroke-width': 1,
        'stroke-dasharray': dash,
        opacity: 0.15,
      }),
    );
  }
  root.appendChild(
    svg('text', {
      x: padLeft,
      y: padTop - 5,
      'font-size': LABEL_FONT,
      fill: 'currentColor',
      opacity: 0.6,
    }, truncate(formatValue(maxValue), 14)),
  );

  const points = series.map((d, i) => [xAt(i), yAt(d.value)]);

  if (points.length > 1) {
    const lineD = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${points[points.length - 1][0].toFixed(1)} ${(padTop + innerH).toFixed(1)} L${points[0][0].toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;
    root.appendChild(svg('path', { d: areaD, fill: 'currentColor', opacity: 0.08 }));
    root.appendChild(
      svg('path', {
        d: lineD,
        fill: 'none',
        stroke: color,
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }

  // Thin the labels until they fit; always keep the first and the last.
  const needed = rotate ? 13 : longest * CHAR_W + 8;
  const step = Math.max(1, Math.ceil(needed / Math.max(slot, 1)));

  series.forEach((d, i) => {
    const [x, y] = points[i];
    const dot = svg('circle', {
      cx: x.toFixed(1),
      cy: y.toFixed(1),
      r: points.length > 24 ? 2 : 3,
      fill: color,
      stroke: 'var(--bg-elevated, var(--bg))',
      'stroke-width': 1.5,
    });
    dot.appendChild(svg('title', {}, `${d.label || 'Unlabelled'}: ${formatValue(d.value)}`));
    root.appendChild(dot);

    const isEdge = i === 0 || i === series.length - 1;
    if (!isEdge && i % step !== 0) return;

    const labelY = height - (rotate ? 16 : 6);
    const attrs = {
      x: x.toFixed(1),
      y: labelY,
      'font-size': LABEL_FONT,
      fill: 'currentColor',
      opacity: 0.65,
      'text-anchor': rotate ? 'end' : 'middle',
    };
    if (rotate) attrs.transform = `rotate(-35 ${x.toFixed(1)} ${labelY})`;
    root.appendChild(svg('text', attrs, truncate(d.label, 8)));
  });

  return root;
}

/* ------------------------------------------------------------------ *
 * Clipboard & dates
 * ------------------------------------------------------------------ */

/**
 * Copy text to the clipboard. Uses the async Clipboard API where available and
 * falls back to a hidden textarea + `execCommand('copy')` on insecure origins
 * (a plain `http://` LAN address, for instance).
 * @param {string} text
 * @returns {Promise<boolean>} `true` when the text reached the clipboard.
 */
export async function copyToClipboard(text) {
  const value = String(text === null || text === undefined ? '' : text);
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or insecure context — fall through to the legacy path.
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;

  const previouslyFocused = document.activeElement;
  const area = el('textarea', {
    value,
    readOnly: true,
    'aria-hidden': 'true',
    tabIndex: -1,
    style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0', pointerEvents: 'none' },
  });

  document.body.appendChild(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, value.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    area.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
  return ok;
}

/**
 * Parse a date-ish value into a local `Date`.
 * `YYYY-MM-DD` is read as a LOCAL calendar day (never UTC midnight), so a
 * date never drifts by one day in western time zones.
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whole-day difference between two dates, compared on local calendar days. */
function dayDelta(a, b) {
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((dayA - dayB) / 86400000);
}

/**
 * Friendly date label.
 *   - today            -> "Today"
 *   - yesterday        -> "Yesterday"
 *   - this year        -> "12 Sep"
 *   - any other year   -> "12 Sep 2025"
 *
 * @param {string|number|Date} iso An ISO date/date-time string, timestamp or Date.
 * @param {object} [options]
 * @param {boolean} [options.relative=true] Set `false` to always use the
 *   day/month form.
 * @param {string|number|Date} [options.now] Reference "today", for tests.
 * @param {string|number|Date} [now] Reference "today" as a positional argument.
 * @returns {string} `''` when the input cannot be parsed.
 */
export function formatDate(iso, options = {}, now = undefined) {
  const date = toDate(iso);
  if (!date) return '';

  const { relative = true } = options || {};
  const reference = toDate(now !== undefined ? now : (options || {}).now) || new Date();

  if (relative) {
    const delta = dayDelta(date, reference);
    if (delta === 0) return 'Today';
    if (delta === -1) return 'Yesterday';
  }

  const day = date.getDate();
  const month = MONTHS[date.getMonth()];
  if (date.getFullYear() === reference.getFullYear()) return `${day} ${month}`;
  return `${day} ${month} ${date.getFullYear()}`;
}
