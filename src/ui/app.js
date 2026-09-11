/**
 * app.js — application shell and router.
 *
 * Owns the single `<main id="view">` element, the hash router, the store
 * subscription, and the chrome (sidebar, bottom tab bar, theme toggle).
 * Views are dumb: they receive a context object and render into a container.
 */

import * as store from '../core/store.js';
import { readShareUrl } from '../core/share.js';
import { el, icon, toast, modal, sheet, confirmDialog } from './components.js';

import * as dashboardView from './dashboard.js';
import * as groupView from './group.js';
import * as expensesView from './expenses.js';
import * as expenseFormView from './expense-form.js';
import * as balancesView from './balances.js';
import * as settleView from './settle.js';
import * as membersView from './members.js';
import * as insightsView from './insights.js';
import * as settingsView from './settings.js';

/** @type {Record<string, {render: (c: HTMLElement, ctx: object) => void}>} */
const VIEWS = {
  dashboard: dashboardView,
  group: groupView,
  expenses: expensesView,
  'expense-form': expenseFormView,
  balances: balancesView,
  settle: settleView,
  members: membersView,
  insights: insightsView,
  settings: settingsView,
};

/** Tabs shown inside a group, in order. */
const GROUP_TABS = [
  { name: 'expenses', label: 'Expenses', icon: 'receipt' },
  { name: 'balances', label: 'Balances', icon: 'scale' },
  { name: 'settle', label: 'Settle up', icon: 'handshake' },
  { name: 'insights', label: 'Insights', icon: 'chart' },
  { name: 'members', label: 'People', icon: 'users' },
];

let currentModal = null;
let currentSheet = null;
let lastRouteKey = null;

/**
 * Parse `location.hash` into a route descriptor.
 * Unknown routes fall back to the dashboard.
 * @param {string} hash
 * @returns {{name: string, params: Record<string,string>}}
 */
export function parseRoute(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const path = raw.split('?')[0];
  const parts = path.split('/').filter(Boolean);

  if (parts.length === 0) return { name: 'dashboard', params: {} };
  if (parts[0] === 'settings') return { name: 'settings', params: {} };

  if (parts[0] === 'g' && parts[1]) {
    const groupId = decodeURIComponent(parts[1]);
    const section = parts[2];

    if (!section) return { name: 'group', params: { groupId } };
    if (section === 'expense') {
      const eid = parts[3] ? decodeURIComponent(parts[3]) : null;
      return {
        name: 'expense-form',
        params: { groupId, expenseId: eid === 'new' ? null : eid },
      };
    }
    if (GROUP_TABS.some((t) => t.name === section)) {
      return { name: section, params: { groupId } };
    }
    return { name: 'group', params: { groupId } };
  }

  return { name: 'dashboard', params: {} };
}

/** Navigate by pushing a new hash. */
function navigate(hash) {
  const next = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === next) render();
  else location.hash = next;
}

/** Replace the hash without adding a history entry. */
function replace(hash) {
  const next = hash.startsWith('#') ? hash : `#${hash}`;
  history.replaceState(null, '', next);
  render();
}

/** Build the context object handed to every view. */
function buildContext(route) {
  const state = store.getState();
  const group = route.params.groupId
    ? state.groups.find((g) => g.id === route.params.groupId) || null
    : store.getActiveGroup();

  return {
    state,
    group,
    route,
    tabs: GROUP_TABS,
    dispatch: store.dispatch,
    navigate,
    replace,
    toast,
    openModal(opts) {
      currentModal?.close?.();
      currentModal = modal(opts);
      return currentModal;
    },
    closeModal() {
      currentModal?.close?.();
      currentModal = null;
    },
    openSheet(opts) {
      currentSheet?.close?.();
      currentSheet = sheet(opts);
      return currentSheet;
    },
    closeSheet() {
      currentSheet?.close?.();
      currentSheet = null;
    },
    confirm: confirmDialog,
  };
}

/** Render the active view into `<main id="view">`. */
function render() {
  const container = document.getElementById('view');
  if (!container) return;

  const route = parseRoute(location.hash);
  const ctx = buildContext(route);

  // A route pointing at a group that no longer exists goes home.
  if (route.params.groupId && !ctx.group) {
    replace('#/');
    return;
  }

  const view = VIEWS[route.name] || VIEWS.dashboard;

  container.replaceChildren();
  try {
    view.render(container, ctx);
  } catch (err) {
    console.error('[SplitUPI] view failed to render', err);
    container.replaceChildren(renderCrash(err, ctx));
  }

  renderChrome(route, ctx);

  // Only reset scroll when the route actually changed, so a re-render
  // caused by a state update does not yank the user back to the top.
  const routeKey = `${route.name}:${route.params.groupId || ''}:${route.params.expenseId || ''}`;
  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    container.focus?.({ preventScroll: true });
  }

  document.title = ctx.group && route.name !== 'dashboard' && route.name !== 'settings'
    ? `${ctx.group.name} · SplitUPI`
    : 'SplitUPI — Split bills, settle over UPI';
}

/** A last-resort panel so a view bug never leaves a blank screen. */
function renderCrash(err, ctx) {
  return el('div.card.crash', {}, [
    el('h2', {}, 'Something broke while drawing this screen'),
    el('p.muted', {}, 'Your data is safe — it is stored on this device and was not touched.'),
    el('pre.crash-detail', {}, String(err && err.stack ? err.stack : err)),
    el('div.cluster', {}, [
      el('button.btn.btn-primary', { on: { click: () => ctx.navigate('#/') } }, 'Go home'),
      el('button.btn.btn-ghost', { on: { click: () => location.reload() } }, 'Reload'),
    ]),
  ]);
}

/** Sidebar (desktop) and bottom tab bar (mobile). */
function renderChrome(route, ctx) {
  const sidebar = document.getElementById('app-sidebar');
  const tabbar = document.getElementById('app-tabbar');
  const inGroup = Boolean(ctx.group) && route.name !== 'dashboard' && route.name !== 'settings';

  const items = inGroup
    ? GROUP_TABS.map((t) => ({
        href: `#/g/${encodeURIComponent(ctx.group.id)}/${t.name}`,
        label: t.label,
        icon: t.icon,
        active: route.name === t.name,
      }))
    : [
        { href: '#/', label: 'Groups', icon: 'home', active: route.name === 'dashboard' },
        { href: '#/settings', label: 'Settings', icon: 'settings', active: route.name === 'settings' },
      ];

  if (sidebar) {
    sidebar.replaceChildren(
      el('nav.sidebar-nav', {},
        inGroup
          ? el('a.sidebar-back', { href: '#/' }, [icon('back', 18), 'All groups'])
          : null,
        inGroup ? el('p.sidebar-title', {}, ctx.group.name) : el('p.sidebar-title', {}, 'SplitUPI'),
        ...items.map((i) =>
          el('a.nav-item.sidebar-item', {
            href: i.href,
            class: i.active ? 'sidebar-item is-active' : 'sidebar-item',
            'aria-current': i.active ? 'page' : null,
          }, [icon(i.icon, 20), el('span', {}, i.label)]),
        ),
      ),
    );
  }

  if (tabbar) {
    tabbar.replaceChildren(
      ...items.map((i) =>
        el('a.nav-item.tabbar-item', {
          href: i.href,
          class: i.active ? 'tabbar-item is-active' : 'tabbar-item',
          'aria-current': i.active ? 'page' : null,
        }, [icon(i.icon, 22), el('span', {}, i.label)]),
      ),
    );
    tabbar.hidden = items.length < 2;
  }
}

/** Theme toggle: cycles system -> light -> dark. */
function setupTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const paint = () => {
    const theme = store.getState().settings.theme || 'system';
    const label = theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'sparkle';
    btn.replaceChildren(icon(label, 20));
    btn.title = `Theme: ${theme} (click to change)`;
    btn.setAttribute('aria-label', `Colour theme: ${theme}. Click to change.`);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  };

  btn.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const now = store.getState().settings.theme || 'system';
    const next = order[(order.indexOf(now) + 1) % order.length];
    store.dispatch({ type: 'settings/update', settings: { theme: next } });
    paint();
    toast(`Theme set to ${next}`, 'info');
  });

  store.subscribe(paint);
  paint();
}

/**
 * If the URL carries `#g=<token>`, offer to import the shared group.
 * @returns {Promise<boolean>} true when a share link was handled
 */
async function handleShareLink() {
  if (!location.hash.startsWith('#g=')) return false;

  try {
    const group = await readShareUrl(location.href);
    if (!group) return false;

    const existing = store.getState().groups.find((g) => g.id === group.id);
    const ok = await confirmDialog({
      title: existing ? `Update "${group.name}"?` : `Import "${group.name}"?`,
      body: existing
        ? `You already have this group. Importing will replace your copy with the shared version (${group.members.length} people, ${group.expenses.length} expenses).`
        : `This shared link contains ${group.members.length} people and ${group.expenses.length} expenses. It will be saved on this device only.`,
      confirmLabel: existing ? 'Replace my copy' : 'Import group',
    });

    if (ok) {
      store.dispatch({ type: 'group/upsert', group });
      store.dispatch({ type: 'group/select', groupId: group.id });
      replace(`#/g/${encodeURIComponent(group.id)}/expenses`);
      toast(`Imported "${group.name}"`, 'success');
    } else {
      replace('#/');
    }
    return true;
  } catch (err) {
    console.error('[SplitUPI] share link failed', err);
    toast('That share link could not be read. It may be damaged or truncated.', 'error');
    replace('#/');
    return true;
  }
}

/** Boot. */
async function start() {
  store.loadFromStorage();
  setupTheme();

  const handled = await handleShareLink();
  if (!handled) render();

  store.subscribe(render);
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#g=')) handleShareLink();
    else render();
  });

  // Keyboard shortcuts, skipped while the user is typing.
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
      || document.activeElement?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    const group = store.getActiveGroup();
    if (e.key === 'n' && group) {
      e.preventDefault();
      navigate(`#/g/${encodeURIComponent(group.id)}/expense/new`);
    } else if (e.key === 'g') {
      e.preventDefault();
      navigate('#/');
    } else if (e.key === '?') {
      e.preventDefault();
      modal({
        title: 'Keyboard shortcuts',
        body: el('ul.list', {},
          el('li.list-item', {}, [el('kbd', {}, 'n'), ' New expense']),
          el('li.list-item', {}, [el('kbd', {}, 'g'), ' All groups']),
          el('li.list-item', {}, [el('kbd', {}, '?'), ' This help']),
        ),
        actions: [{ label: 'Close', primary: true }],
      });
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
