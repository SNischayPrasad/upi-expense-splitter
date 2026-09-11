import { el, emptyState, icon, pageHeader } from './components.js';
import { computeBalances } from '../core/balances.js';
import { money, openCreateGroup, totalExpenses } from './view-helpers.js';

export function render(container, ctx) {
  const groups = ctx.state.groups || [];
  const create = el('button.btn.btn-primary', { type: 'button', on: { click: () => openCreateGroup(ctx) } }, [icon('plus', 18), ' Create group']);
  container.appendChild(pageHeader({ title: 'Your shared money, settled.', subtitle: groups.length ? `${groups.length} active ${groups.length === 1 ? 'group' : 'groups'} on this device.` : 'No account. No server. Just your groups.', actions: create }));
  if (!groups.length) {
    container.appendChild(emptyState({ icon: 'users', title: 'Start with a group', body: 'Create a home, trip, or event group. Add people and SplitUPI will keep the balances clear.', action: create.cloneNode(true) }));
    container.querySelector('.empty .btn')?.addEventListener('click', () => openCreateGroup(ctx));
    return;
  }
  const cards = el('div.group-grid', {});
  for (const group of groups) {
    const balances = computeBalances(group); const spend = totalExpenses(group); const unpaid = balances.filter((balance) => balance.net !== 0).length;
    cards.appendChild(el('a.card.group-card', { href: `#/g/${encodeURIComponent(group.id)}`, on: { click: () => ctx.dispatch({ type: 'group/select', groupId: group.id }) } }, [
      el('div.group-card-top', {}, [el('span.group-emoji', { 'aria-hidden': 'true' }, group.emoji || '🧾'), el('span.badge', {}, group.type || 'group'), icon('chevron-right', 18)]),
      el('h2', {}, group.name),
      el('p.muted', {}, `${group.members.length} ${group.members.length === 1 ? 'person' : 'people'} · ${group.expenses.length} ${group.expenses.length === 1 ? 'expense' : 'expenses'}`),
      el('div.group-card-money', {}, [el('strong.money', {}, money(spend)), el('span.muted.text-sm', {}, 'recorded')]),
      el('p.group-card-footer', {}, unpaid ? `${unpaid} people have an open balance` : 'Everyone is settled up'),
    ]));
  }
  container.appendChild(cards);
}
