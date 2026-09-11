import { el, field, icon, pageHeader } from './components.js';
import { validateVpa } from '../core/upi.js';
import { newId } from '../core/id.js';

export function render(container, ctx) {
  const { group } = ctx; const add = el('button.btn.btn-primary', { type: 'button', on: { click: () => openMemberForm(ctx) } }, [icon('plus', 18), ' Add person']);
  container.appendChild(pageHeader({ title: 'People', subtitle: 'UPI IDs stay on this device until you share the group.', back: `#/g/${encodeURIComponent(group.id)}`, actions: add }));
  const list = el('div.list');
  for (const member of group.members) {
    const edit = el('button.btn.btn-icon.btn-ghost', { type: 'button', 'aria-label': `Edit ${member.name}`, on: { click: () => openMemberForm(ctx, member) } }, icon('edit', 18));
    list.appendChild(el('div.list-item.member-row', {}, [el('div.member-avatar-placeholder', {}, member.name.slice(0, 1).toUpperCase()), el('div.fill', {}, [el('strong', {}, member.name), el('p.muted', {}, member.upi || 'No UPI ID yet')]), edit]));
  }
  container.appendChild(list);
}

function openMemberForm(ctx, existing = null) {
  const name = el('input.input', { type: 'text', value: existing?.name || '', maxlength: 80, required: true, autofocus: true });
  const upi = el('input.input', { type: 'text', value: existing?.upi || '', maxlength: 120, placeholder: 'name@bank' });
  const error = el('p.field-error', { hidden: true, role: 'alert' });
  const form = el('form.stack', {}, [field({ label: 'Name', input: name }), field({ label: 'UPI ID (optional)', input: upi, hint: 'Used only to create a payment request.' }), error, el('div.form-actions', {}, [el('button.btn.btn-primary', { type: 'submit' }, existing ? 'Save person' : 'Add person')])]);
  form.addEventListener('submit', (event) => { event.preventDefault(); error.hidden = true; const cleanName = name.value.trim(); const vpa = upi.value.trim() ? validateVpa(upi.value) : { ok: true, normalized: null }; if (!cleanName) { error.textContent = 'Enter a name.'; error.hidden = false; return; } if (!vpa.ok) { error.textContent = vpa.error; error.hidden = false; return; } const member = { id: existing?.id || newId('mem'), name: cleanName, upi: vpa.normalized, colorIndex: existing?.colorIndex ?? ctx.group.members.length % 8 }; ctx.dispatch({ type: existing ? 'member/update' : 'member/add', groupId: ctx.group.id, memberId: existing?.id, member }); ctx.closeModal(); ctx.toast(existing ? 'Person updated' : 'Person added', 'success'); });
  const actions = [form];
  if (existing && ctx.group.members.length > 1) {
    const remove = el('button.btn.btn-danger', {
      type: 'button',
      on: {
        click: async () => {
          const ok = await ctx.confirm({ title: `Remove ${existing.name}?`, body: 'This removes the person from future splits. Check historical expenses before doing this.', confirmLabel: 'Remove person', danger: true });
          if (!ok) return;
          ctx.dispatch({ type: 'member/remove', groupId: ctx.group.id, memberId: existing.id });
          ctx.closeModal();
          ctx.toast('Person removed', 'success');
        },
      },
    }, [icon('trash', 16), ' Remove person']);
    actions.push(remove);
  }
  ctx.openModal({ title: existing ? `Edit ${existing.name}` : 'Add person', body: el('div.stack', {}, actions) });
}
