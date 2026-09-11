import { el, field, icon, pageHeader } from './components.js';
import { expensesToCsv, settlementsToCsv } from '../core/csv.js';
import { seedDemoGroup } from '../core/store.js';
import { downloadFile } from './view-helpers.js';

export function render(container, ctx) {
  const settings = ctx.state.settings; const active = ctx.state.groups.find((group) => group.id === ctx.state.activeGroupId) || ctx.state.groups[0];
  container.appendChild(pageHeader({ title: 'Settings', subtitle: 'Your choices are stored locally on this device.' }));
  const who = el('select.select', {}, [el('option', { value: '' }, 'Not set'), ...ctx.state.groups.flatMap((group) => group.members.map((member) => el('option', { value: member.id, selected: settings.myMemberId === member.id }, `${member.name} · ${group.name}`)))]);
  who.addEventListener('change', () => ctx.dispatch({ type: 'settings/update', settings: { myMemberId: who.value || null } }));
  const upi = el('input.input', { type: 'text', value: settings.defaultUpi || '', placeholder: 'Optional default UPI ID' });
  upi.addEventListener('change', () => ctx.dispatch({ type: 'settings/update', settings: { defaultUpi: upi.value.trim() } }));
  const simple = toggle('Simplify debts', 'Combine IOUs into fewer payments when possible.', settings.simplifyDebts !== false, (checked) => ctx.dispatch({ type: 'settings/update', settings: { simplifyDebts: checked } }));
  const exportJson = el('button.btn.btn-ghost', { type: 'button', on: { click: () => { downloadFile(`splitupi-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(ctx.state, null, 2)); ctx.toast('Backup downloaded', 'success'); } } }, [icon('download', 17), ' Full backup (JSON)']);
  const exportExpenses = el('button.btn.btn-ghost', { type: 'button', disabled: !active, on: { click: () => { if (!active) return; downloadFile(`${safeName(active.name)}-expenses.csv`, expensesToCsv(active), 'text/csv;charset=utf-8'); } } }, [icon('download', 17), ' Expenses CSV']);
  const exportSettlements = el('button.btn.btn-ghost', { type: 'button', disabled: !active, on: { click: () => { if (!active) return; downloadFile(`${safeName(active.name)}-settlements.csv`, settlementsToCsv(active), 'text/csv;charset=utf-8'); } } }, [icon('download', 17), ' Settlements CSV']);
  const input = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  const importButton = el('button.btn.btn-ghost', { type: 'button', on: { click: () => input.click() } }, [icon('upload', 17), ' Restore backup']);
  input.addEventListener('change', async () => { const file = input.files?.[0]; if (!file) return; try { const parsed = JSON.parse(await file.text()); if (!parsed || !Array.isArray(parsed.groups)) throw new Error('That file does not look like a SplitUPI backup.'); const ok = await ctx.confirm({ title: 'Restore this backup?', body: 'It replaces the current local data on this device. Download a backup first if you need one.', confirmLabel: 'Restore backup', danger: true }); if (!ok) return; ctx.dispatch({ type: 'state/replace', state: parsed }); ctx.toast('Backup restored', 'success'); } catch (error) { ctx.toast(error.message || 'Could not read that backup.', 'error'); } finally { input.value = ''; } });
  const demo = el('button.btn.btn-ghost', {
    type: 'button',
    on: {
      click: async () => {
        const ok = await ctx.confirm({ title: 'Add the sample group?', body: 'This adds a made-up “Goa Trip (sample)” group — four people, eight expenses and one settlement — so you can try SplitUPI with something in it. Nothing you already have is touched, and you can delete the sample group whenever you like.', confirmLabel: 'Add sample group' });
        if (!ok) return;
        const next = ctx.dispatch({ type: 'group/create', group: seedDemoGroup() });
        const created = next.groups[next.groups.length - 1];
        if (!created) { ctx.toast('Could not add the sample group.', 'error'); return; }
        ctx.navigate(`#/g/${encodeURIComponent(created.id)}`);
        ctx.toast('Sample group added — it is made-up data, delete it any time', 'success');
      },
    },
  }, [icon('sparkle', 17), ' Load demo data']);
  const reset = el('button.btn.btn-danger', {
    type: 'button',
    on: {
      click: async () => {
        const ok = await ctx.confirm({ title: 'Erase local SplitUPI data?', body: 'This removes every group, expense, and UPI ID stored in this browser. This cannot be undone.', confirmLabel: 'Erase data', danger: true });
        if (!ok) return;
        ctx.dispatch({ type: 'state/replace', state: { version: 3, groups: [], activeGroupId: null, settings: {} } });
        ctx.navigate('#/');
        ctx.toast('Local data erased', 'success');
      },
    },
  }, [icon('trash', 17), ' Erase all local data']);
  container.append(
    el('section.card.stack', {}, [el('h2', {}, 'Personal defaults'), field({ label: 'This is me', input: who, hint: 'Used to highlight your balance.' }), field({ label: 'Default UPI ID', input: upi, hint: 'Optional; people’s individual UPI IDs take precedence.' }), simple]),
    el('section.card.stack', {}, [el('h2', {}, 'Your data'), el('p.muted', {}, 'SplitUPI has no account or server. Downloads stay on your device until you send them.'), el('div.stack', {}, [exportJson, exportExpenses, exportSettlements, importButton, input])]),
    el('section.card.stack', {}, [el('h2', {}, 'Sample data'), el('p.muted', {}, 'New here? Add a made-up group to see balances, a settle-up plan and UPI QR codes without entering anything real.'), demo]),
    el('section.card.stack.danger-zone', {}, [el('h2', {}, 'Danger zone'), el('p.muted', {}, 'Removing data only affects this browser.'), reset]),
  );
}

function toggle(title, detail, checked, onChange) { const input = el('input', { type: 'checkbox', checked }); input.addEventListener('change', () => onChange(input.checked)); return el('label.toggle-row', {}, [el('div.fill', {}, [el('strong', {}, title), el('p.muted.text-sm', {}, detail)]), input]); }
function safeName(value) { return String(value || 'splitupi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'splitupi'; }
