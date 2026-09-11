/** Ledger projections for a group. All values are integer paise. */
import { allocateByWeights, sum } from './money.js';
import { computeShares } from './split.js';

const validMembers = (group) => Array.isArray(group?.members) ? group.members : [];

/** Net position per member: positive means the group owes them money. */
export function computeBalances(group) {
  const net = new Map(validMembers(group).map((member) => [member.id, 0]));
  for (const expense of Array.isArray(group?.expenses) ? group.expenses : []) {
    try {
      for (const payer of expense.paidBy || []) {
        if (net.has(payer.memberId) && Number.isInteger(payer.paise)) net.set(payer.memberId, net.get(payer.memberId) + payer.paise);
      }
      for (const share of computeShares(expense)) {
        if (net.has(share.memberId)) net.set(share.memberId, net.get(share.memberId) - share.paise);
      }
    } catch { /* Ignore a legacy/corrupt entry rather than breaking the whole ledger. */ }
  }
  for (const settlement of Array.isArray(group?.settlements) ? group.settlements : []) {
    if (!Number.isInteger(settlement.paise) || settlement.paise <= 0) continue;
    if (net.has(settlement.from)) net.set(settlement.from, net.get(settlement.from) + settlement.paise);
    if (net.has(settlement.to)) net.set(settlement.to, net.get(settlement.to) - settlement.paise);
  }
  return [...net].map(([memberId, value]) => ({ memberId, net: value })).sort((a, b) => b.net - a.net || a.memberId.localeCompare(b.memberId));
}

/**
 * Direct ledger relationships. Multiple payers are allocated proportionally
 * against each participant's share, which preserves every paise exactly.
 */
export function computePairwiseDebts(group) {
  const memberIds = new Set(validMembers(group).map((member) => member.id));
  const debts = new Map();
  const add = (from, to, paise) => {
    if (!memberIds.has(from) || !memberIds.has(to) || from === to || !Number.isInteger(paise) || paise === 0) return;
    const key = `${from}\u0000${to}`;
    debts.set(key, (debts.get(key) || 0) + paise);
  };
  for (const expense of Array.isArray(group?.expenses) ? group.expenses : []) {
    try {
      const payers = (expense.paidBy || []).filter((payer) => memberIds.has(payer.memberId) && Number.isInteger(payer.paise) && payer.paise > 0);
      const paid = sum(payers.map((payer) => payer.paise));
      if (!payers.length || paid !== expense.amount) continue;
      for (const share of computeShares(expense)) {
        if (!memberIds.has(share.memberId) || share.paise <= 0) continue;
        const pieces = allocateByWeights(share.paise, payers.map((payer) => payer.paise));
        payers.forEach((payer, index) => add(share.memberId, payer.memberId, pieces[index]));
      }
    } catch { /* A bad historical expense is omitted, not fatal. */ }
  }
  // Settlements cancel debts in the same direction. If an old payment was made
  // to a different person, retain a reverse credit instead of losing money.
  for (const settlement of Array.isArray(group?.settlements) ? group.settlements : []) {
    if (!memberIds.has(settlement.from) || !memberIds.has(settlement.to) || !Number.isInteger(settlement.paise) || settlement.paise <= 0) continue;
    add(settlement.to, settlement.from, settlement.paise);
  }
  const out = [];
  const visited = new Set();
  for (const [key, amount] of debts) {
    if (visited.has(key)) continue;
    const [from, to] = key.split('\u0000');
    const reverseKey = `${to}\u0000${from}`;
    const reverse = debts.get(reverseKey) || 0;
    visited.add(key); visited.add(reverseKey);
    const difference = amount - reverse;
    if (difference > 0) out.push({ from, to, paise: difference });
    if (difference < 0) out.push({ from: to, to: from, paise: -difference });
  }
  return out.sort((a, b) => b.paise - a.paise || a.from.localeCompare(b.from));
}

/** Per-person paid, owed and current net totals for reporting. */
export function memberTotals(group) {
  const totals = new Map(validMembers(group).map((member) => [member.id, { paid: 0, owed: 0, net: 0, expenseCount: 0 }]));
  for (const expense of Array.isArray(group?.expenses) ? group.expenses : []) {
    try {
      for (const payer of expense.paidBy || []) {
        const entry = totals.get(payer.memberId);
        if (entry && Number.isInteger(payer.paise)) { entry.paid += payer.paise; entry.expenseCount += 1; }
      }
      for (const share of computeShares(expense)) {
        const entry = totals.get(share.memberId);
        if (entry) entry.owed += share.paise;
      }
    } catch { /* ignore invalid historic expense */ }
  }
  const balances = new Map(computeBalances(group).map((balance) => [balance.memberId, balance.net]));
  for (const [id, entry] of totals) entry.net = balances.get(id) || 0;
  return totals;
}

/** Category to spending total, descending. */
export function categoryTotals(group) {
  const entries = new Map();
  for (const expense of Array.isArray(group?.expenses) ? group.expenses : []) {
    if (!Number.isInteger(expense.amount)) continue;
    const category = typeof expense.category === 'string' && expense.category.trim() ? expense.category.trim() : 'Other';
    entries.set(category, (entries.get(category) || 0) + expense.amount);
  }
  return [...entries].map(([category, paise]) => ({ category, paise })).sort((a, b) => b.paise - a.paise || a.category.localeCompare(b.category));
}

/** Month (YYYY-MM) to total paise, oldest first. */
export function monthlyTotals(group) {
  const entries = new Map();
  for (const expense of Array.isArray(group?.expenses) ? group.expenses : []) {
    if (!Number.isInteger(expense.amount)) continue;
    const month = typeof expense.date === 'string' && /^\d{4}-\d{2}/.test(expense.date) ? expense.date.slice(0, 7) : 'Unknown';
    entries.set(month, (entries.get(month) || 0) + expense.amount);
  }
  return [...entries].map(([month, paise]) => ({ month, paise })).sort((a, b) => a.month.localeCompare(b.month));
}
