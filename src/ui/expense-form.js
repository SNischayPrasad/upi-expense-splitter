import { el, field, icon, pageHeader, segmented } from './components.js';
import { parseAmount, formatPaise } from '../core/money.js';
import { validateSplit } from '../core/split.js';
import { newId } from '../core/id.js';
import { byId, money, today } from './view-helpers.js';

const TYPES = [
  ['equal', 'Equally'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares'], ['adjustment', 'Adjust'], ['itemized', 'Items'],
];

export function render(container, ctx) {
  const { group, route } = ctx; const existing = route.params.expenseId ? group.expenses.find((expense) => expense.id === route.params.expenseId) : null;
  const isEdit = Boolean(existing); const initial = existing || defaultExpense(group);
  const description = el('input.input', { name: 'description', type: 'text', maxlength: 200, value: initial.description, placeholder: 'What was this for?', required: true, autofocus: true });
  const amount = el('input.input.amount-field', { name: 'amount', type: 'text', inputmode: 'decimal', value: formatPaise(initial.amount), placeholder: '0.00', required: true });
  const date = el('input.input', { name: 'date', type: 'date', value: initial.date, required: true });
  const category = el('select.select', { name: 'category' }, categories(initial.category));
  const payer = el('select.select', { name: 'payer' }, group.members.map((member) => el('option', { value: member.id, selected: initial.paidBy?.[0]?.memberId === member.id }, member.name)));
  const participants = el('div.participant-picker', {});
  const selected = new Set(initial.participants);
  for (const member of group.members) participants.appendChild(el('label.chip', {}, [el('input', { type: 'checkbox', name: 'participant', value: member.id, checked: selected.has(member.id) }), member.name]));
  const splitType = el('select.select', { name: 'splitType' }, TYPES.map(([value, label]) => el('option', { value, selected: value === initial.splitType }, label)));
  const splitDetails = el('div.split-details');
  const notes = el('textarea.input', { name: 'notes', rows: 3, maxlength: 2000, placeholder: 'Optional note', value: initial.notes || '' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const form = el('form.stack.expense-form', {}, [
    el('div.form-grid', {}, [field({ label: 'Description', input: description }), field({ label: 'Amount', input: amount, hint: '₹' })]),
    el('div.form-grid', {}, [field({ label: 'Paid by', input: payer }), field({ label: 'Date', input: date })]),
    field({ label: 'Category', input: category }),
    field({ label: 'Who shared it?', input: participants, hint: 'Select every person included in this expense.' }),
    field({ label: 'Split method', input: splitType }), splitDetails, field({ label: 'Note', input: notes }), error,
    el('div.form-actions', {}, [el('a.btn.btn-ghost', { href: `#/g/${encodeURIComponent(group.id)}/expenses` }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, isEdit ? 'Save changes' : 'Add expense')]),
  ]);
  const selection = () => [...form.querySelectorAll('input[name="participant"]:checked')].map((input) => input.value);
  const drawDetails = () => {
    const people = selection(); const current = splitType.value; splitDetails.replaceChildren();
    if (!people.length) return;
    if (current === 'equal') { splitDetails.appendChild(el('p.muted.text-sm', {}, `Split evenly between ${people.length} ${people.length === 1 ? 'person' : 'people'}.`)); return; }
    if (current === 'itemized') { splitDetails.appendChild(el('p.muted.text-sm', {}, 'Itemised mode starts with one shared item for the full bill. Add custom item lines after saving if you need a detailed receipt.')); return; }
    const label = current === 'exact' ? 'Amount (₹)' : current === 'percent' ? 'Percentage' : current === 'shares' ? 'Number of shares' : 'Extra / less (₹)';
    const defaults = initial.splitType === current && initial.splitData ? initial.splitData : {};
    splitDetails.appendChild(el('div.card.compact-card', {}, [el('p.muted.text-sm', {}, label), ...people.map((id, index) => el('label.split-input-row', {}, [el('span', {}, byId(group, id).name), el('input.input', { type: 'text', inputmode: 'decimal', name: `split:${id}`, value: valueFor(current, defaults[id], people.length, initial.amount, index) })]))]));
  };
  splitType.addEventListener('change', drawDetails); participants.addEventListener('change', drawDetails); drawDetails();
  form.addEventListener('submit', (event) => {
    event.preventDefault(); error.hidden = true;
    try {
      const total = parseAmount(amount.value); if (total <= 0) throw new Error('Enter an amount greater than zero.');
      const people = selection(); if (!people.length) throw new Error('Choose at least one person who shared this expense.');
      const type = splitType.value; const data = makeSplitData(type, people, total, form);
      const expense = { id: existing?.id || newId('exp'), description: description.value.trim(), amount: total, paidBy: [{ memberId: payer.value, paise: total }], splitType: type, participants: people, splitData: data, category: category.value, date: date.value || today(), notes: notes.value.trim(), createdAt: existing?.createdAt || new Date().toISOString() };
      if (!expense.description) throw new Error('Add a short description.');
      const validation = validateSplit(expense); if (!validation.ok) throw new Error(validation.error);
      ctx.dispatch({ type: isEdit ? 'expense/update' : 'expense/add', groupId: group.id, expenseId: existing?.id, expense });
      ctx.toast(isEdit ? 'Expense updated' : 'Expense added', 'success'); ctx.navigate(`#/g/${encodeURIComponent(group.id)}/expenses`);
    } catch (exception) { error.textContent = exception.message || 'Could not save this expense.'; error.hidden = false; error.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  const actions = [];
  if (isEdit) actions.push(el('button.btn.btn-danger', { type: 'button', on: { click: async () => { if (await ctx.confirm({ title: 'Delete this expense?', body: 'This cannot be undone. Balances will be recalculated immediately.', confirmLabel: 'Delete expense', danger: true })) { ctx.dispatch({ type: 'expense/delete', groupId: group.id, expenseId: existing.id }); ctx.toast('Expense deleted', 'success'); ctx.navigate(`#/g/${encodeURIComponent(group.id)}/expenses`); } } } }, [icon('trash', 17), ' Delete']));
  container.append(pageHeader({ title: isEdit ? 'Edit expense' : 'New expense', subtitle: 'Every amount is stored in exact paise.', back: `#/g/${encodeURIComponent(group.id)}/expenses`, actions }), form);
}

function defaultExpense(group) { const ids = group.members.map((member) => member.id); return { description: '', amount: 0, paidBy: [{ memberId: ids[0], paise: 0 }], splitType: 'equal', participants: ids, splitData: {}, category: 'Other', date: today(), notes: '' }; }
function categories(selected) { const values = ['Other', 'Food & drinks', 'Groceries', 'Travel', 'Stay', 'Utilities', 'Entertainment', 'Shopping']; return values.map((value) => el('option', { value, selected: value === selected }, value)); }
function valueFor(type, value, count, amount, index) { if (value !== undefined && value !== null) return type === 'exact' || type === 'adjustment' ? formatPaise(value) : String(value); if (type === 'exact') return formatPaise(Math.floor(amount / count) + (index < amount % count ? 1 : 0)); if (type === 'percent') return String(Math.floor(10000 / count) / 100 + (index === count - 1 ? 100 - (Math.floor(10000 / count) / 100) * count : 0)); if (type === 'shares') return '1'; return '0.00'; }
function makeSplitData(type, people, amount, form) {
  if (type === 'equal') return {};
  if (type === 'itemized') return { items: [{ id: newId('item'), name: 'Shared bill', amount, participants: people }], tax: 0, tip: 0, discount: 0 };
  const data = {};
  for (const id of people) { const input = form.querySelector(`[name="split:${CSS.escape(id)}"]`); const raw = input?.value.trim() || ''; if (type === 'exact' || type === 'adjustment') data[id] = parseAmount(raw); else { const value = Number(raw); if (!Number.isFinite(value)) throw new Error(`Enter a valid value for each person.`); data[id] = value; } }
  return data;
}
