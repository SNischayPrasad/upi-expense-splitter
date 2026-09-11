/**
 * store.js — small local-first state container.
 *
 * The ledger never leaves the browser unless the person using SplitUPI chooses
 * an export or share action.  Keeping persistence here makes the rest of the
 * engine deterministic and easy to test.
 */

import { newId } from './id.js';

export const STORAGE_KEY = 'splitupi:state:v3';

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  simplifyDebts: true,
  currencySymbol: true,
  myMemberId: null,
  defaultUpi: '',
});

const EMPTY_STATE = () => ({
  version: 3,
  groups: [],
  activeGroupId: null,
  settings: { ...DEFAULT_SETTINGS },
});

let state = EMPTY_STATE();
const subscribers = new Set();

/** Return the current state. Treat it as read-only outside this module. */
export function getState() {
  return state;
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Return the selected group, or the first group when no selection exists. */
export function getActiveGroup() {
  return state.groups.find((group) => group.id === state.activeGroupId)
    || state.groups[0]
    || null;
}

/** Restore persisted data. A malformed or unavailable store starts empty. */
export function loadFromStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return state;
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return state;
    state = migrate(JSON.parse(raw));
  } catch {
    state = EMPTY_STATE();
  }
  return state;
}

/** Persist state when storage is available (private mode may deny writes). */
export function saveToStorage() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Upgrade/clean persisted data into the current plain-object schema. */
export function migrate(raw) {
  const source = isObject(raw) ? raw : {};
  const groups = Array.isArray(source.groups) ? source.groups.map(normalizeGroup).filter(Boolean) : [];
  const activeGroupId = groups.some((group) => group.id === source.activeGroupId)
    ? source.activeGroupId
    : groups[0]?.id || null;
  return {
    version: 3,
    groups,
    activeGroupId,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(isObject(source.settings) ? pickSettings(source.settings) : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Sample data
 * ------------------------------------------------------------------ */

/** Member ids for the sample group. Fixed so seeding is reproducible. */
const DEMO = Object.freeze({
  GROUP: 'grp_demo_goa',
  NISCHAY: 'mem_demo_nischay',
  RHEA: 'mem_demo_rhea',
  ARJUN: 'mem_demo_arjun',
  MEERA: 'mem_demo_meera',
});

/**
 * Build the sample "Goa Trip" group shown to first-time visitors.
 *
 * Returns a fresh, fully-formed v3 group; it is NOT dispatched and NOT
 * persisted, so the caller decides when (and whether) it enters the ledger.
 *
 * Every id, date and amount is a literal — no `Date.now()`, no `Math.random()`,
 * no `newId()` — so two calls deep-equal each other and the demo looks the same
 * on every device and in every test run.
 *
 * The data deliberately exercises the whole engine: two expenses with multiple
 * payers, an `equal`, `shares`, `exact`, `adjustment` and `itemized` split, two
 * expenses that only some of the group took part in, five categories, and one
 * settlement already paid. Balances sum to exactly 0.
 *
 * @returns {object} a group ready for `dispatch({type: 'group/create', group})`
 */
export function seedDemoGroup() {
  const { NISCHAY, RHEA, ARJUN, MEERA } = DEMO;

  return {
    id: DEMO.GROUP,
    name: 'Goa Trip (sample)',
    emoji: '🏖️',
    type: 'trip',
    createdAt: '2026-08-12T09:00:00.000Z',
    members: [
      { id: NISCHAY, name: 'Nischay', upi: 'nischay@okhdfcbank', colorIndex: 0 },
      { id: RHEA, name: 'Rhea Kapoor', upi: 'rhea.k@ybl', colorIndex: 1 },
      { id: ARJUN, name: 'Arjun Menon', upi: 'arjun1998@paytm', colorIndex: 2 },
      { id: MEERA, name: 'Meera Iyer', upi: 'meera@oksbi', colorIndex: 3 },
    ],
    expenses: [
      {
        // Two people put the flights on their own cards.
        id: 'exp_demo_flights',
        description: 'Flights to Goa (4 tickets)',
        amount: 2480000,
        paidBy: [{ memberId: NISCHAY, paise: 1240000 }, { memberId: RHEA, paise: 1240000 }],
        splitType: 'equal',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: {},
        category: 'Travel',
        date: '2026-08-14',
        notes: 'Booked three weeks ahead.',
        createdAt: '2026-08-14T06:30:00.000Z',
      },
      {
        // Arjun took the sea-facing suite, so he carries a double share.
        id: 'exp_demo_villa',
        description: 'Beach villa, 3 nights',
        amount: 3150000,
        paidBy: [{ memberId: RHEA, paise: 3150000 }],
        splitType: 'shares',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: { [NISCHAY]: 1, [RHEA]: 1, [ARJUN]: 2, [MEERA]: 1 },
        category: 'Stay',
        date: '2026-08-14',
        notes: 'Arjun took the sea-facing suite — double share.',
        createdAt: '2026-08-14T15:10:00.000Z',
      },
      {
        // Itemised: each dish goes to whoever ate it, tax and tip pro-rata.
        id: 'exp_demo_dinner',
        description: 'Dinner at Gunpowder',
        amount: 270400,
        paidBy: [{ memberId: ARJUN, paise: 270400 }],
        splitType: 'itemized',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: {
          items: [
            { id: 'itm_demo_prawn', name: 'Prawn balchao', amount: 68000, participants: [NISCHAY, ARJUN] },
            { id: 'itm_demo_thali', name: 'Goan fish thali', amount: 45000, participants: [RHEA] },
            { id: 'itm_demo_xacuti', name: 'Veg xacuti', amount: 39000, participants: [MEERA] },
            { id: 'itm_demo_beer', name: 'Kings beer x4', amount: 96000, participants: [NISCHAY, RHEA, ARJUN, MEERA] },
          ],
          tax: 12400,
          tip: 10000,
          discount: 0,
        },
        category: 'Food',
        date: '2026-08-15',
        notes: '',
        createdAt: '2026-08-15T16:05:00.000Z',
      },
      {
        // Only the two who actually rode the scooters.
        id: 'exp_demo_scooter',
        description: 'Scooter rental, 2 days',
        amount: 160000,
        paidBy: [{ memberId: NISCHAY, paise: 160000 }],
        splitType: 'equal',
        participants: [NISCHAY, ARJUN],
        splitData: {},
        category: 'Travel',
        date: '2026-08-15',
        notes: 'Rhea and Meera stayed with the cab.',
        createdAt: '2026-08-15T04:45:00.000Z',
      },
      {
        // Exact amounts: the guide charged per person, not per head.
        id: 'exp_demo_trek',
        description: 'Dudhsagar falls trek',
        amount: 600000,
        paidBy: [{ memberId: MEERA, paise: 600000 }],
        splitType: 'exact',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: { [NISCHAY]: 175000, [RHEA]: 145000, [ARJUN]: 145000, [MEERA]: 135000 },
        category: 'Activities',
        date: '2026-08-16',
        notes: 'Nischay hired the extra guide.',
        createdAt: '2026-08-16T03:20:00.000Z',
      },
      {
        // Nischay sat this one out.
        id: 'exp_demo_scuba',
        description: 'Scuba diving at Grande Island',
        amount: 990000,
        paidBy: [{ memberId: RHEA, paise: 990000 }],
        splitType: 'equal',
        participants: [RHEA, ARJUN, MEERA],
        splitData: {},
        category: 'Activities',
        date: '2026-08-16',
        notes: '',
        createdAt: '2026-08-16T09:00:00.000Z',
      },
      {
        id: 'exp_demo_souvenirs',
        description: 'Cashews and souvenirs',
        amount: 345000,
        paidBy: [{ memberId: MEERA, paise: 345000 }],
        splitType: 'equal',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: {},
        category: 'Shopping',
        date: '2026-08-17',
        notes: '',
        createdAt: '2026-08-17T11:40:00.000Z',
      },
      {
        // Adjustment: one extra bag, then the rest split evenly.
        id: 'exp_demo_cab',
        description: 'Airport cab home',
        amount: 118000,
        paidBy: [{ memberId: ARJUN, paise: 60000 }, { memberId: MEERA, paise: 58000 }],
        splitType: 'adjustment',
        participants: [NISCHAY, RHEA, ARJUN, MEERA],
        splitData: { [NISCHAY]: 20000 },
        category: 'Travel',
        date: '2026-08-18',
        notes: 'Nischay paid the oversize-baggage charge.',
        createdAt: '2026-08-18T05:15:00.000Z',
      },
    ],
    settlements: [
      {
        id: 'stl_demo_flights',
        from: NISCHAY,
        to: RHEA,
        paise: 250000,
        date: '2026-08-19',
        method: 'upi',
        ref: 'SPLITUPIDEMO01',
        note: 'Part payment towards the villa',
      },
    ],
    recurring: [],
  };
}

/** Clear all locally stored data. */
export function resetAll() {
  state = EMPTY_STATE();
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
  notify();
}

/**
 * Apply a named action, persist it, and notify subscribers.  Actions are kept
 * intentionally boring so UI code remains legible in a no-framework app.
 */
export function dispatch(action = {}) {
  if (!isObject(action) || typeof action.type !== 'string') return state;

  const next = clone(state);
  let changed = false;
  const groupById = (id) => next.groups.find((group) => group.id === id);

  switch (action.type) {
    case 'group/create': {
      const group = normalizeGroup(action.group || action);
      if (!group) break;
      if (next.groups.some((item) => item.id === group.id)) group.id = newId('grp');
      next.groups.push(group);
      next.activeGroupId = group.id;
      changed = true;
      break;
    }
    case 'group/update': {
      const group = groupById(action.groupId || action.id);
      if (!group || !isObject(action.group || action.patch || action)) break;
      const patch = action.group || action.patch || action;
      for (const key of ['name', 'emoji', 'type']) {
        if (key in patch && typeof patch[key] === 'string') group[key] = patch[key].trim() || group[key];
      }
      changed = true;
      break;
    }
    case 'group/delete': {
      const id = action.groupId || action.id;
      const before = next.groups.length;
      next.groups = next.groups.filter((group) => group.id !== id);
      if (next.groups.length !== before) {
        next.activeGroupId = next.groups.some((group) => group.id === next.activeGroupId)
          ? next.activeGroupId
          : next.groups[0]?.id || null;
        changed = true;
      }
      break;
    }
    case 'group/select': {
      const id = action.groupId || action.id;
      if (next.groups.some((group) => group.id === id) && next.activeGroupId !== id) {
        next.activeGroupId = id;
        changed = true;
      }
      break;
    }
    case 'group/upsert': {
      const group = normalizeGroup(action.group);
      if (!group) break;
      const index = next.groups.findIndex((item) => item.id === group.id);
      if (index === -1) next.groups.push(group);
      else next.groups[index] = group;
      if (!next.activeGroupId) next.activeGroupId = group.id;
      changed = true;
      break;
    }
    case 'member/add': {
      const group = groupById(action.groupId);
      if (!group) break;
      const member = normalizeMember(action.member || action, group.members.length);
      if (!member) break;
      if (group.members.some((item) => item.id === member.id)) member.id = newId('mem');
      group.members.push(member);
      changed = true;
      break;
    }
    case 'member/update': {
      const group = groupById(action.groupId);
      const id = action.memberId || action.id;
      const member = group?.members.find((item) => item.id === id);
      const patch = action.member || action.patch || action;
      if (!member || !isObject(patch)) break;
      if (typeof patch.name === 'string' && patch.name.trim()) member.name = patch.name.trim().slice(0, 80);
      if ('upi' in patch) member.upi = cleanText(patch.upi, 120) || null;
      if (Number.isInteger(patch.colorIndex)) member.colorIndex = Math.max(0, patch.colorIndex % 8);
      changed = true;
      break;
    }
    case 'member/remove': {
      const group = groupById(action.groupId);
      const id = action.memberId || action.id;
      if (!group || group.members.length <= 1 || !group.members.some((member) => member.id === id)) break;
      group.members = group.members.filter((member) => member.id !== id);
      // Historical entries remain valid by removing the departed person from
      // future-visible split lists. Views warn before exposing this action.
      for (const expense of group.expenses) {
        expense.participants = expense.participants.filter((memberId) => memberId !== id);
        expense.paidBy = expense.paidBy.filter((payer) => payer.memberId !== id);
      }
      changed = true;
      break;
    }
    case 'expense/add': {
      const group = groupById(action.groupId);
      const expense = normalizeExpense(action.expense || action, group);
      if (!group || !expense) break;
      if (group.expenses.some((item) => item.id === expense.id)) expense.id = newId('exp');
      group.expenses.push(expense);
      changed = true;
      break;
    }
    case 'expense/update': {
      const group = groupById(action.groupId);
      const id = action.expenseId || action.id;
      if (!group) break;
      const index = group.expenses.findIndex((item) => item.id === id);
      if (index === -1) break;
      const expense = normalizeExpense({ ...group.expenses[index], ...(action.expense || action.patch || {}) }, group);
      if (!expense) break;
      expense.id = id;
      group.expenses[index] = expense;
      changed = true;
      break;
    }
    case 'expense/delete': {
      const group = groupById(action.groupId);
      const id = action.expenseId || action.id;
      if (!group) break;
      const before = group.expenses.length;
      group.expenses = group.expenses.filter((expense) => expense.id !== id);
      changed = before !== group.expenses.length;
      break;
    }
    case 'settlement/add': {
      const group = groupById(action.groupId);
      const settlement = normalizeSettlement(action.settlement || action, group);
      if (!group || !settlement) break;
      if (group.settlements.some((item) => item.id === settlement.id)) settlement.id = newId('stl');
      group.settlements.push(settlement);
      changed = true;
      break;
    }
    case 'settlement/delete': {
      const group = groupById(action.groupId);
      const id = action.settlementId || action.id;
      if (!group) break;
      const before = group.settlements.length;
      group.settlements = group.settlements.filter((settlement) => settlement.id !== id);
      changed = before !== group.settlements.length;
      break;
    }
    case 'settings/update': {
      const patch = action.settings || action.patch || {};
      if (!isObject(patch)) break;
      next.settings = { ...next.settings, ...pickSettings(patch) };
      changed = true;
      break;
    }
    case 'state/import':
    case 'state/replace': {
      const incoming = action.state || action.data;
      if (!incoming) break;
      state = migrate(incoming);
      saveToStorage();
      notify();
      return state;
    }
    default:
      return state;
  }

  if (changed) {
    state = next;
    saveToStorage();
    notify();
  }
  return state;
}

function notify() {
  for (const fn of [...subscribers]) {
    try { fn(state); } catch (error) { console.error('[SplitUPI] store subscriber failed', error); }
  }
}

function normalizeGroup(raw) {
  if (!isObject(raw)) return null;
  const members = Array.isArray(raw.members) ? raw.members.map(normalizeMember).filter(Boolean) : [];
  if (!members.length && Array.isArray(raw.initialMembers)) {
    for (const member of raw.initialMembers) {
      const normalized = normalizeMember(member, members.length);
      if (normalized) members.push(normalized);
    }
  }
  if (!members.length) return null;
  const group = {
    id: cleanId(raw.id, 'grp'),
    name: cleanText(raw.name, 120) || 'Untitled group',
    emoji: cleanText(raw.emoji, 12) || '🧾',
    type: ['trip', 'home', 'event', 'other'].includes(raw.type) ? raw.type : 'other',
    createdAt: isoStamp(raw.createdAt),
    members,
    expenses: [],
    settlements: [],
    recurring: Array.isArray(raw.recurring) ? clone(raw.recurring) : [],
  };
  group.expenses = Array.isArray(raw.expenses)
    ? raw.expenses.map((expense) => normalizeExpense(expense, group)).filter(Boolean)
    : [];
  group.settlements = Array.isArray(raw.settlements)
    ? raw.settlements.map((settlement) => normalizeSettlement(settlement, group)).filter(Boolean)
    : [];
  return group;
}

function normalizeMember(raw, index = 0) {
  if (!isObject(raw) && typeof raw !== 'string') return null;
  const source = typeof raw === 'string' ? { name: raw } : raw;
  const name = cleanText(source.name, 80);
  if (!name) return null;
  return {
    id: cleanId(source.id, 'mem'),
    name,
    upi: cleanText(source.upi, 120) || null,
    colorIndex: Number.isInteger(source.colorIndex) ? Math.abs(source.colorIndex) % 8 : index % 8,
  };
}

function normalizeExpense(raw, group) {
  if (!isObject(raw) || !group) return null;
  const validMembers = new Set(group.members.map((member) => member.id));
  const amount = Number.isInteger(raw.amount) ? raw.amount : null;
  if (amount === null || amount === 0) return null;
  const participants = unique((Array.isArray(raw.participants) ? raw.participants : group.members.map((member) => member.id))
    .filter((id) => validMembers.has(id)));
  const paidBy = normalizePayers(raw.paidBy, raw.paidById || raw.payerId, amount, validMembers);
  if (!participants.length || !paidBy.length) return null;
  const splitType = ['equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized'].includes(raw.splitType)
    ? raw.splitType
    : 'equal';
  return {
    id: cleanId(raw.id, 'exp'),
    description: cleanText(raw.description, 200) || 'Untitled expense',
    amount,
    paidBy,
    splitType,
    participants,
    splitData: isObject(raw.splitData) ? clone(raw.splitData) : {},
    category: cleanText(raw.category, 60) || 'Other',
    date: isoDate(raw.date),
    notes: cleanText(raw.notes, 2000),
    createdAt: isoStamp(raw.createdAt),
    ...(typeof raw.recurringId === 'string' ? { recurringId: raw.recurringId } : {}),
  };
}

function normalizePayers(value, fallbackId, amount, validMembers) {
  // v1 stored a single payer as a bare member-id string (`paidBy: 'mem_x'`);
  // v2 moved it to `paidById`/`payerId`. Both become the v3 Payer[] shape, with
  // the whole expense attributed to that one person.
  const legacyId = typeof value === 'string'
    ? value
    : typeof fallbackId === 'string' ? fallbackId : null;
  const source = Array.isArray(value)
    ? value
    : legacyId ? [{ memberId: legacyId, paise: amount }] : [];
  const payers = source
    .filter((payer) => isObject(payer) && validMembers.has(payer.memberId) && Number.isInteger(payer.paise) && payer.paise > 0)
    .map((payer) => ({ memberId: payer.memberId, paise: payer.paise }));
  const total = payers.reduce((sum, payer) => sum + payer.paise, 0);
  return total === amount ? payers : [];
}

function normalizeSettlement(raw, group) {
  if (!isObject(raw) || !group) return null;
  const validMembers = new Set(group.members.map((member) => member.id));
  if (!validMembers.has(raw.from) || !validMembers.has(raw.to) || raw.from === raw.to) return null;
  if (!Number.isInteger(raw.paise) || raw.paise <= 0) return null;
  return {
    id: cleanId(raw.id, 'stl'),
    from: raw.from,
    to: raw.to,
    paise: raw.paise,
    date: isoDate(raw.date),
    method: ['upi', 'cash', 'other'].includes(raw.method) ? raw.method : 'upi',
    ref: cleanText(raw.ref, 64),
    note: cleanText(raw.note, 1000),
  };
}

function pickSettings(raw) {
  const out = {};
  if (['system', 'light', 'dark'].includes(raw.theme)) out.theme = raw.theme;
  if (typeof raw.simplifyDebts === 'boolean') out.simplifyDebts = raw.simplifyDebts;
  if (typeof raw.currencySymbol === 'boolean') out.currencySymbol = raw.currencySymbol;
  if (typeof raw.myMemberId === 'string' || raw.myMemberId === null) out.myMemberId = raw.myMemberId;
  if (typeof raw.defaultUpi === 'string') out.defaultUpi = cleanText(raw.defaultUpi, 120);
  return out;
}

function cleanId(value, prefix) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : newId(prefix);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

function isoStamp(value) {
  return typeof value === 'string' && value ? value.slice(0, 40) : new Date().toISOString();
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
