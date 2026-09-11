/** RFC-4180-ish CSV export/import helpers for local data portability. */
import { parseAmount } from './money.js';
import { newId } from './id.js';
import { computeBalances } from './balances.js';

/**
 * UTF-8 byte-order mark. Without it Excel opens a .csv as the system ANSI code
 * page, which mangles ₹ and every non-ASCII name in the group.
 */
const BOM = '﻿';

const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const rowsToCsv = (rows) => `${BOM}${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
const memberName = (group, id) => group?.members?.find((member) => member.id === id)?.name || id || '';

/**
 * Integer paise -> a plain machine-readable rupee decimal (456789 -> "4567.89").
 * Deliberately NOT `formatPaise`: Indian digit grouping ("1,23,456.78") makes the
 * cell ambiguous against the comma delimiter and stops every spreadsheet and
 * importer from reading it as a number.
 * @param {number} paise
 * @returns {string} always exactly two decimal places, no symbol, no grouping
 */
const rupees = (paise) => {
  const n = Number.isFinite(paise) ? Math.trunc(paise) : 0;
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export function expensesToCsv(group) {
  const rows = [['Date', 'Description', 'Amount (INR)', 'Category', 'Paid by', 'Participants', 'Split type', 'Notes', 'ID']];
  for (const expense of group?.expenses || []) {
    rows.push([expense.date || '', expense.description || '', rupees(expense.amount || 0), expense.category || '', (expense.paidBy || []).map((payer) => `${memberName(group, payer.memberId)}: ${rupees(payer.paise)}`).join('; '), (expense.participants || []).map((id) => memberName(group, id)).join('; '), expense.splitType || 'equal', expense.notes || '', expense.id || '']);
  }
  return rowsToCsv(rows);
}

export function settlementsToCsv(group) {
  const rows = [['Date', 'From', 'To', 'Amount (INR)', 'Method', 'Reference', 'Note', 'ID']];
  for (const item of group?.settlements || []) rows.push([item.date || '', memberName(group, item.from), memberName(group, item.to), rupees(item.paise || 0), item.method || '', item.ref || '', item.note || '', item.id || '']);
  return rowsToCsv(rows);
}

export function balancesToCsv(group) {
  const rows = [['Person', 'Net balance (INR)']];
  const balances = new Map(computeBalances(group).map((balance) => [balance.memberId, balance.net]));
  for (const member of group?.members || []) rows.push([member.name, rupees(balances.get(member.id) || 0)]);
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
  const errors = []; const expenses = [];
  // A structurally broken file is an error to report, not an exception to throw:
  // the contract for this function is {expenses, errors}.
  let rows;
  try { rows = parseCsv(text); } catch (error) { return { expenses, errors: [error.message || 'The CSV could not be read.'] }; }
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
      const payerText = String(row[at('paid by')] || '').split(':')[0].trim();
      // A named payer who is not in this group must be reported. Falling back to
      // the first member would silently credit the money to the wrong person.
      const payer = payerText === '' ? group?.members?.[0]?.id : people.get(payerText.toLowerCase());
      if (payerText !== '' && !payer) throw new Error(`no member named "${payerText}" in this group`);
      const participants = String(row[at('participants')] || '').split(';').map((name) => people.get(name.trim().toLowerCase())).filter(Boolean);
      if (!payer || !participants.length) throw new Error('could not match payer or participants to this group');
      expenses.push({ id: newId('exp'), description: row[descriptionAt].trim() || 'Imported expense', amount, paidBy: [{ memberId: payer, paise: amount }], participants, splitType: 'equal', splitData: {}, category: row[at('category')] || 'Other', date: /^\d{4}-\d{2}-\d{2}/.test(row[at('date')] || '') ? row[at('date')].slice(0, 10) : new Date().toISOString().slice(0, 10), notes: row[at('notes')] || '', createdAt: new Date().toISOString() });
    } catch (error) { errors.push(`Row ${index + 1}: ${error.message || 'could not be imported'}`); }
  }
  return { expenses, errors };
}
