/** RFC-4180-ish CSV export/import helpers for local data portability. */
import { parseAmount, formatPaise } from './money.js';
import { newId } from './id.js';
import { computeBalances } from './balances.js';

const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const rowsToCsv = (rows) => `${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
const memberName = (group, id) => group?.members?.find((member) => member.id === id)?.name || id || '';

export function expensesToCsv(group) {
  const rows = [['Date', 'Description', 'Amount (INR)', 'Category', 'Paid by', 'Participants', 'Split type', 'Notes', 'ID']];
  for (const expense of group?.expenses || []) {
    rows.push([expense.date || '', expense.description || '', formatPaise(expense.amount || 0), expense.category || '', (expense.paidBy || []).map((payer) => `${memberName(group, payer.memberId)}: ${formatPaise(payer.paise)}`).join('; '), (expense.participants || []).map((id) => memberName(group, id)).join('; '), expense.splitType || 'equal', expense.notes || '', expense.id || '']);
  }
  return rowsToCsv(rows);
}

export function settlementsToCsv(group) {
  const rows = [['Date', 'From', 'To', 'Amount (INR)', 'Method', 'Reference', 'Note', 'ID']];
  for (const item of group?.settlements || []) rows.push([item.date || '', memberName(group, item.from), memberName(group, item.to), formatPaise(item.paise || 0), item.method || '', item.ref || '', item.note || '', item.id || '']);
  return rowsToCsv(rows);
}

export function balancesToCsv(group) {
  const rows = [['Person', 'Net balance (INR)']];
  const balances = new Map(computeBalances(group).map((balance) => [balance.memberId, balance.net]));
  for (const member of group?.members || []) rows.push([member.name, formatPaise(balances.get(member.id) || 0)]);
  return rowsToCsv(rows);
}

/** Parse quoted CSV rows without executing any data. */
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new RangeError('The CSV has an unclosed quoted value.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((item) => item.some((value) => value !== ''));
}

/** Import a SplitUPI expense export into a destination group. */
export function csvToExpenses(text, group) {
  const rows = parseCsv(text); const errors = []; const expenses = [];
  if (!rows.length) return { expenses, errors: ['The CSV is empty.'] };
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const at = (name) => headers.indexOf(name);
  const amountAt = at('amount (inr)'); const descriptionAt = at('description');
  if (amountAt < 0 || descriptionAt < 0) return { expenses, errors: ['Expected Description and Amount (INR) columns.'] };
  const people = new Map((group?.members || []).map((member) => [member.name.trim().toLowerCase(), member.id]));
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      const amount = parseAmount(row[amountAt]);
      const payerText = row[at('paid by')] || '';
      const payerName = payerText.split(':')[0].trim().toLowerCase();
      const payer = people.get(payerName) || group?.members?.[0]?.id;
      const participants = String(row[at('participants')] || '').split(';').map((name) => people.get(name.trim().toLowerCase())).filter(Boolean);
      if (!payer || !participants.length) throw new Error('could not match payer or participants to this group');
      expenses.push({ id: newId('exp'), description: row[descriptionAt].trim() || 'Imported expense', amount, paidBy: [{ memberId: payer, paise: amount }], participants, splitType: 'equal', splitData: {}, category: row[at('category')] || 'Other', date: /^\d{4}-\d{2}-\d{2}/.test(row[at('date')] || '') ? row[at('date')].slice(0, 10) : new Date().toISOString().slice(0, 10), notes: row[at('notes')] || '', createdAt: new Date().toISOString() });
    } catch (error) { errors.push(`Row ${index + 1}: ${error.message || 'could not be imported'}`); }
  }
  return { expenses, errors };
}
