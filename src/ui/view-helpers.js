import { el, avatar, icon, field } from './components.js';
import { formatINR } from '../core/money.js';
import { newId } from '../core/id.js';

export const today = () => new Date().toISOString().slice(0, 10);
export const byId = (group, id) => group?.members?.find((member) => member.id === id) || { id, name: 'Unknown person' };
export const nameOf = (group, id) => byId(group, id).name;
export const money = (value, opts = {}) => formatINR(Number.isInteger(value) ? value : 0, opts);
export const totalExpenses = (group) => (group?.expenses || []).reduce((total, expense) => total + (Number.isInteger(expense.amount) ? expense.amount : 0), 0);

export function memberPicker(group, selected = [], name = 'participants') {
  const checked = new Set(selected);
  return el('div.participant-picker', {}, ...(group?.members || []).map((member) => el('label.chip', {}, [
    el('input', { type: 'checkbox', name, value: member.id, checked: checked.has(member.id) }),
    avatar(member, 24), member.name,
  ])));
}

export function expenseListItem(group, expense, { href, actionLabel = 'Edit' } = {}) {
  const payer = (expense.paidBy || []).map((item) => `${nameOf(group, item.memberId)} paid`).join(', ') || 'No payer';
  const description = expense.description || 'Untitled expense';
  const content = el('div.expense-row-content', {}, [
    el('div.expense-row-icon', { 'aria-hidden': 'true' }, icon(categoryIcon(expense.category), 18)),
    el('div.fill', {}, [
      el('strong', {}, description),
      el('p.muted.text-sm', {}, `${payer} · ${expense.category || 'Other'} · ${expense.date || ''}`),
    ]),
    el('div.expense-row-amount', {}, money(expense.amount)),
    icon('chevron-right', 18),
  ]);
  return href ? el('a.list-item.expense-row', { href, 'aria-label': `${actionLabel} ${description}` }, content) : el('div.list-item.expense-row', {}, content);
}

export function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Open the first-run/create-group dialog. */
export function openCreateGroup(ctx) {
  const name = el('input.input', { name: 'group-name', type: 'text', required: true, maxlength: 120, placeholder: 'e.g. Goa getaway', autofocus: true });
  const type = el('select.select', { name: 'group-type' }, [
    el('option', { value: 'home' }, 'Shared home'), el('option', { value: 'trip', selected: true }, 'Trip'), el('option', { value: 'event' }, 'Event'), el('option', { value: 'other' }, 'Other'),
  ]);
  const emoji = el('input.input', { name: 'group-emoji', type: 'text', maxlength: 8, value: '🧾', 'aria-label': 'Group emoji' });
  const members = el('div.stack#new-members', {}, memberNameInput('You'));
  const add = el('button.btn.btn-ghost', { type: 'button' }, [icon('plus', 16), ' Add person']);
  const form = el('form.stack', {}, [
    field({ label: 'Group name', input: name, hint: 'Keep it simple — people will see this in shared links.' }),
    el('div.form-grid', {}, [field({ label: 'Type', input: type }), field({ label: 'Emoji', input: emoji })]),
    el('div.stack', {}, [el('div.row', {}, [el('label', {}, 'People'), add]), members]),
    el('p.muted.text-sm', {}, 'Everything is saved only on this device. You can add UPI IDs later.'),
    el('div.form-actions', {}, [el('button.btn.btn-primary', { type: 'submit' }, 'Create group')]),
  ]);
  add.addEventListener('click', () => members.appendChild(memberNameInput('')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const names = [...members.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
    if (!name.value.trim()) { name.focus(); return; }
    if (!names.length) { members.querySelector('input')?.focus(); return; }
    const group = {
      id: newId('grp'), name: name.value.trim(), type: type.value, emoji: emoji.value.trim() || '🧾', createdAt: new Date().toISOString(),
      members: names.map((memberName, index) => ({ id: newId('mem'), name: memberName, upi: null, colorIndex: index })), expenses: [], settlements: [], recurring: [],
    };
    ctx.dispatch({ type: 'group/create', group }); ctx.closeModal(); ctx.navigate(`#/g/${encodeURIComponent(group.id)}`); ctx.toast(`Created ${group.name}`, 'success');
  });
  ctx.openModal({ title: 'Create a group', body: form });
}

function memberNameInput(value) {
  return el('input.input', { type: 'text', maxlength: 80, value, placeholder: 'Name', 'aria-label': 'Person name' });
}

function categoryIcon(category) {
  const text = String(category || '').toLowerCase();
  if (/(travel|flight|train|taxi|transport)/.test(text)) return 'plane';
  if (/(food|dining|restaurant|grocery)/.test(text)) return 'receipt';
  if (/(home|rent|utility)/.test(text)) return 'home';
  if (/(party|event)/.test(text)) return 'party';
  return 'wallet';
}
