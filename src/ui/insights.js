import { el, barChart, donutChart, lineChart, pageHeader } from './components.js';
import { categoryTotals, memberTotals, monthlyTotals } from '../core/balances.js';
import { money, totalExpenses } from './view-helpers.js';

const COLORS = ['#5233c9', '#0e7c52', '#c2410c', '#0369a1', '#9d1aa8', '#b45309', '#0f766e', '#be123c'];

export function render(container, ctx) {
  const { group } = ctx; const spend = totalExpenses(group); const categories = categoryTotals(group); const monthly = monthlyTotals(group); const totals = memberTotals(group);
  container.appendChild(pageHeader({ title: 'Insights', subtitle: 'A clear picture of where the group’s money went.', back: `#/g/${encodeURIComponent(group.id)}` }));
  container.appendChild(el('div.stat-row', {}, [stat('Total spent', money(spend)), stat('Average expense', group.expenses.length ? money(Math.round(spend / group.expenses.length)) : '—'), stat('Categories', String(categories.length))]));
  const categoryChart = donutChart(categories.map((entry, index) => ({ label: entry.category, value: entry.paise, color: COLORS[index % COLORS.length] })), { centerLabel: 'Spent', formatValue: money });
  const categoryBars = barChart(categories.map((entry, index) => ({ label: entry.category, value: entry.paise, color: COLORS[index % COLORS.length] })), { formatValue: money });
  container.appendChild(el('div.grid-2', {}, [el('section.card.stack', {}, [el('h2', {}, 'By category'), categoryChart]), el('section.card.stack', {}, [el('h2', {}, 'Category detail'), categoryBars])]));
  container.appendChild(el('section.card.stack', {}, [el('h2', {}, 'Spending over time'), lineChart(monthly.map((entry) => ({ label: entry.month, value: entry.paise })), { formatValue: money })]));
  const people = el('section.card.stack', {}, [el('h2', {}, 'By person')]); const list = el('div.list');
  for (const member of group.members) { const entry = totals.get(member.id) || { paid: 0, owed: 0, net: 0, expenseCount: 0 }; list.appendChild(el('div.list-item', {}, [el('div.fill', {}, [el('strong', {}, member.name), el('p.muted', {}, `${entry.expenseCount} payments · paid ${money(entry.paid)}`)]), el('strong', { class: entry.net > 0 ? 'money money-pos' : entry.net < 0 ? 'money money-neg' : 'money' }, entry.net === 0 ? 'Settled' : entry.net > 0 ? `+${money(entry.net)}` : `−${money(-entry.net)}`)])); }
  people.appendChild(list); container.appendChild(people);
}
function stat(label, value) { return el('div.stat', {}, [el('span.stat-label', {}, label), el('strong.stat-value', {}, value)]); }
