import { el, icon, pageHeader, emptyState } from './components.js';
import { computeBalances } from '../core/balances.js';
import { money, expenseListItem, totalExpenses } from './view-helpers.js';

export function render(container, ctx) {
  const { group } = ctx;
  const add = el('a.btn.btn-primary', { href: `#/g/${encodeURIComponent(group.id)}/expense/new` }, [icon('plus', 18), ' Add expense']);
  container.appendChild(pageHeader({ title: `${group.emoji || '🧾'} ${group.name}`, subtitle: `${group.members.length} people · local to this device`, back: '#/', actions: add }));
  const balances = computeBalances(group); const open = balances.filter((balance) => balance.net !== 0).length;
  container.appendChild(el('div.stat-row', {}, [
    stat('Total recorded', money(totalExpenses(group))), stat('Open balances', open ? `${open} people` : 'All settled'), stat('Expenses', String(group.expenses.length)),
  ]));
  const section = el('section.stack', {}, [el('div.row', {}, [el('h2', {}, 'Recent expenses'), el('a.btn.btn-ghost', { href: `#/g/${encodeURIComponent(group.id)}/expenses` }, 'View all')])]);
  const recent = [...group.expenses].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  if (!recent.length) section.appendChild(emptyState({ icon: 'receipt', title: 'No expenses yet', body: 'Add the first payment and SplitUPI will calculate everyone’s share exactly.', action: add.cloneNode(true) }));
  else section.appendChild(el('div.list', {}, recent.map((expense) => expenseListItem(group, expense, { href: `#/g/${encodeURIComponent(group.id)}/expense/${encodeURIComponent(expense.id)}` }))));
  container.appendChild(section);
  container.querySelector('.empty a.btn')?.addEventListener('click', () => {});
}
function stat(label, value) { return el('div.stat', {}, [el('span.stat-label', {}, label), el('strong.stat-value', {}, value)]); }
