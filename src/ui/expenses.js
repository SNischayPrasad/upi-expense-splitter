import { el, emptyState, icon, pageHeader } from './components.js';
import { expenseListItem } from './view-helpers.js';

export function render(container, ctx) {
  const { group } = ctx; const addHref = `#/g/${encodeURIComponent(group.id)}/expense/new`;
  container.appendChild(pageHeader({ title: 'Expenses', subtitle: `${group.expenses.length} recorded`, back: `#/g/${encodeURIComponent(group.id)}`, actions: el('a.btn.btn-primary', { href: addHref }, [icon('plus', 18), ' Add']) }));
  if (!group.expenses.length) { container.appendChild(emptyState({ icon: 'receipt', title: 'Nothing recorded yet', body: 'Capture a bill in a few taps, then SplitUPI will keep every share exact.', action: el('a.btn.btn-primary', { href: addHref }, 'Add expense') })); return; }
  const search = el('input.input', { type: 'search', placeholder: 'Search expenses', 'aria-label': 'Search expenses' });
  const category = el('select.select', { 'aria-label': 'Filter by category' }, [el('option', { value: '' }, 'All categories'), ...[...new Set(group.expenses.map((expense) => expense.category || 'Other'))].sort().map((item) => el('option', { value: item }, item))]);
  const list = el('div.list');
  const paint = () => {
    const needle = search.value.trim().toLowerCase(); const filter = category.value;
    const items = [...group.expenses].filter((expense) => (!needle || `${expense.description} ${expense.notes || ''}`.toLowerCase().includes(needle)) && (!filter || (expense.category || 'Other') === filter)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    list.replaceChildren(...(items.length ? items.map((expense) => expenseListItem(group, expense, { href: `#/g/${encodeURIComponent(group.id)}/expense/${encodeURIComponent(expense.id)}` })) : [el('p.muted.centered', {}, 'No matching expenses.')]));
  };
  search.addEventListener('input', paint); category.addEventListener('change', paint); paint();
  container.append(el('div.filter-row', {}, [search, category]), list, el('a.fab', { href: addHref, 'aria-label': 'Add expense' }, icon('plus', 24)));
}
