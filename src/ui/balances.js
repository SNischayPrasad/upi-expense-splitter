import { el, emptyState, icon, pageHeader, avatar } from './components.js';
import { computeBalances, computePairwiseDebts } from '../core/balances.js';
import { money, nameOf } from './view-helpers.js';

export function render(container, ctx) {
  const { group } = ctx; const balances = computeBalances(group); const myId = ctx.state.settings.myMemberId;
  container.appendChild(pageHeader({ title: 'Balances', subtitle: 'Positive means the group owes them; negative means they owe the group.', back: `#/g/${encodeURIComponent(group.id)}`, actions: el('a.btn.btn-primary', { href: `#/g/${encodeURIComponent(group.id)}/settle` }, [icon('handshake', 18), ' Settle up']) }));
  const mine = balances.find((item) => item.memberId === myId)?.net;
  if (Number.isInteger(mine)) container.appendChild(el('div.card.balance-hero', { class: mine > 0 ? 'card balance-hero is-positive' : mine < 0 ? 'card balance-hero is-negative' : 'card balance-hero' }, [el('span.muted', {}, 'Your position'), el('strong', {}, mine > 0 ? `You’re owed ${money(mine)}` : mine < 0 ? `You owe ${money(-mine)}` : 'You’re all settled up')]));
  const list = el('div.list', {}, balances.map((balance) => {
    const member = group.members.find((item) => item.id === balance.memberId); const label = balance.net > 0 ? `is owed ${money(balance.net)}` : balance.net < 0 ? `owes ${money(-balance.net)}` : 'is settled';
    return el('div.list-item.balance-row', {}, [member ? avatar(member, 38) : el('div.member-avatar-placeholder', {}, '?'), el('div.fill', {}, [el('strong', {}, member?.name || balance.memberId), el('p.muted', {}, label)]), el('strong', { class: balance.net > 0 ? 'money money-pos' : balance.net < 0 ? 'money money-neg' : 'money muted' }, balance.net === 0 ? '₹0.00' : money(balance.net, { sign: true }))]);
  }));
  container.appendChild(list);
  const direct = computePairwiseDebts(group);
  const section = el('section.stack', {}, [el('h2', {}, 'Original IOUs'), el('p.muted', {}, 'This is the direct ledger before SplitUPI combines transfers.')]);
  if (direct.length) section.appendChild(el('div.list', {}, direct.map((transfer) => el('div.list-item', {}, [el('span.fill', {}, `${nameOf(group, transfer.from)} → ${nameOf(group, transfer.to)}`), el('strong.money', {}, money(transfer.paise))]))));
  else section.appendChild(emptyState({ icon: 'check', title: 'No open balances', body: 'Every recorded expense has been settled.' }));
  container.appendChild(section);
}
