/** Settlement-plan helpers. */
import { computePairwiseDebts } from './balances.js';

/** Build a compact set of payments that zeroes the supplied balances. */
export function minimiseTransfers(balances) {
  const creditors = [];
  const debtors = [];
  for (const balance of Array.isArray(balances) ? balances : []) {
    if (!balance || !Number.isInteger(balance.net) || !balance.memberId) continue;
    if (balance.net > 0) creditors.push({ memberId: balance.memberId, remaining: balance.net });
    if (balance.net < 0) debtors.push({ memberId: balance.memberId, remaining: -balance.net });
  }
  creditors.sort((a, b) => b.remaining - a.remaining || a.memberId.localeCompare(b.memberId));
  debtors.sort((a, b) => b.remaining - a.remaining || a.memberId.localeCompare(b.memberId));
  const transfers = [];
  let creditor = 0; let debtor = 0;
  while (creditor < creditors.length && debtor < debtors.length) {
    const from = debtors[debtor]; const to = creditors[creditor];
    const paise = Math.min(from.remaining, to.remaining);
    if (paise > 0) transfers.push({ from: from.memberId, to: to.memberId, paise });
    from.remaining -= paise; to.remaining -= paise;
    if (from.remaining === 0) debtor += 1;
    if (to.remaining === 0) creditor += 1;
  }
  return transfers;
}

/** Original debtor-to-payer relationships, without simplification. */
export function directTransfers(group) {
  return computePairwiseDebts(group);
}

/** Apply a payment plan and return updated balances in original member order. */
export function applyTransfers(balances, transfers) {
  const next = new Map((Array.isArray(balances) ? balances : [])
    .filter((balance) => balance && balance.memberId && Number.isInteger(balance.net))
    .map((balance) => [balance.memberId, balance.net]));
  for (const transfer of Array.isArray(transfers) ? transfers : []) {
    if (!transfer || !Number.isInteger(transfer.paise) || transfer.paise <= 0 || !next.has(transfer.from) || !next.has(transfer.to)) continue;
    next.set(transfer.from, next.get(transfer.from) + transfer.paise);
    next.set(transfer.to, next.get(transfer.to) - transfer.paise);
  }
  return (Array.isArray(balances) ? balances : []).map((balance) => ({ memberId: balance.memberId, net: next.get(balance.memberId) || 0 }));
}
