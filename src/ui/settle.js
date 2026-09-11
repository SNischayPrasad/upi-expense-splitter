import { el, emptyState, icon, pageHeader, modal, copyToClipboard } from './components.js';
import { computeBalances } from '../core/balances.js';
import { minimiseTransfers, directTransfers } from '../core/settle.js';
import { buildUpiUri, buildAppLinks, settlementRef } from '../core/upi.js';
import { encodeQR, toSvg } from '../core/qr.js';
import { newId } from '../core/id.js';
import { money, nameOf } from './view-helpers.js';

export function render(container, ctx) {
  const { group } = ctx; const balances = computeBalances(group);
  const simplified = ctx.state.settings.simplifyDebts !== false;
  const plan = simplified ? minimiseTransfers(balances) : directTransfers(group);
  container.appendChild(pageHeader({ title: 'Settle up', subtitle: simplified ? 'A compact plan that combines IOUs.' : 'Pay the original people you owe.', back: `#/g/${encodeURIComponent(group.id)}`, actions: el('button.btn.btn-ghost', { type: 'button', on: { click: () => ctx.dispatch({ type: 'settings/update', settings: { simplifyDebts: !simplified } }) } }, simplified ? 'Show direct IOUs' : 'Simplify debts') }));
  if (!plan.length) { container.appendChild(emptyState({ icon: 'check', title: 'Everyone is settled', body: 'There are no payments to make in this group.' })); return; }
  const total = plan.reduce((sum, transfer) => sum + transfer.paise, 0);
  container.appendChild(el('div.card.settle-summary', {}, [el('span.muted', {}, `${plan.length} ${plan.length === 1 ? 'payment' : 'payments'} to settle this group`), el('strong', {}, money(total))]));
  const list = el('div.stack', {});
  for (const transfer of plan) {
    const recipient = group.members.find((member) => member.id === transfer.to);
    const source = group.members.find((member) => member.id === transfer.from);
    const pay = el('button.btn.btn-primary', { type: 'button', on: { click: () => openPayment(ctx, transfer, source, recipient) } }, recipient?.upi ? 'Pay via UPI' : 'Record paid');
    const mark = el('button.btn.btn-ghost', { type: 'button', on: { click: () => markPaid(ctx, transfer) } }, 'Mark paid');
    list.appendChild(el('article.transfer', {}, [el('div.transfer-parties', {}, [el('strong', {}, source?.name || transfer.from), icon('arrow-right', 18), el('strong', {}, recipient?.name || transfer.to)]), el('strong.transfer-amount', {}, money(transfer.paise)), el('div.cluster', {}, [pay, mark]) ]));
  }
  container.appendChild(list);
}

function markPaid(ctx, transfer, method = 'upi') {
  ctx.dispatch({ type: 'settlement/add', groupId: ctx.group.id, settlement: { id: newId('stl'), from: transfer.from, to: transfer.to, paise: transfer.paise, date: new Date().toISOString().slice(0, 10), method, ref: settlementRef(ctx.group.id, transfer), note: '' } });
  ctx.closeModal(); ctx.toast('Settlement recorded', 'success');
}

function openPayment(ctx, transfer, source, recipient) {
  if (!recipient?.upi) {
    ctx.openModal({ title: `Record payment to ${recipient?.name || 'recipient'}`, body: el('div.stack', {}, [el('p', {}, `${recipient?.name || 'This person'} has no UPI ID saved. Pay however you prefer, then record it here.`), el('button.btn.btn-primary', { type: 'button', on: { click: () => markPaid(ctx, transfer, 'cash') } }, 'Mark paid by cash / other')]) });
    return;
  }
  let uri;
  try { uri = buildUpiUri({ pa: recipient.upi, pn: recipient.name, am: transfer.paise, tn: `SplitUPI · ${ctx.group.name}`, tr: settlementRef(ctx.group.id, transfer) }); } catch (error) { ctx.toast(error.message, 'error'); return; }
  const content = el('div.stack', {}, [el('p.muted', {}, `${source?.name || 'Payer'} pays ${recipient.name} ${money(transfer.paise)}.`)]);
  try { const frame = el('div.qr-frame'); const svg = toSvg(encodeQR(uri, { ecc: 'M' }), { moduleSize: 5 }); const code = el('div.qr-frame-code'); code.innerHTML = svg; frame.append(code, el('strong.qr-frame-payee', {}, recipient.name), el('span.qr-frame-vpa', {}, recipient.upi), el('strong.qr-frame-amount', {}, money(transfer.paise)), el('span.qr-frame-note', {}, 'Scan with any UPI app')); content.appendChild(frame); } catch { content.appendChild(el('p.muted', {}, 'QR generation was unavailable; use the payment button below.')); }
  const apps = buildAppLinks({ pa: recipient.upi, pn: recipient.name, am: transfer.paise, tn: `SplitUPI · ${ctx.group.name}`, tr: settlementRef(ctx.group.id, transfer) });
  content.appendChild(el('div.upi-apps', {}, apps.map((app) => el('a.upi-app', { href: app.url, style: { '--upi-app-color': app.color } }, [el('span.upi-app-dot'), app.name]))));
  const copy = el('button.btn.btn-ghost', {
    type: 'button',
    on: {
      click: async () => {
        const ok = await copyToClipboard(uri);
        ctx.toast(ok ? 'UPI link copied' : 'Could not copy the UPI link', ok ? 'success' : 'error');
      },
    },
  }, [icon('copy', 16), ' Copy link']);
  const done = el('button.btn.btn-primary', { type: 'button', on: { click: () => markPaid(ctx, transfer) } }, 'I’ve paid — mark settled');
  ctx.openModal({ title: `Pay ${recipient.name}`, body: el('div.stack', {}, [content, el('div.cluster', {}, [copy, done])]) });
}
