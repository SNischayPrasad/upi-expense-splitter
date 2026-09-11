/**
 * settle.js — turning net balances into the shortest possible payment plan.
 *
 * The settle screen asks one question: "what is the smallest number of UPI
 * payments that clears this group?". Greedy largest-debtor/largest-creditor
 * matching answers it with at most n-1 transfers, but it is not optimal: if the
 * group contains independent zero-sum pockets (Asha owes Bina exactly what
 * Chirag owes Dev), each pocket can be settled on its own and the plan gets
 * shorter.
 *
 * Settling k disjoint zero-sum subgroups covering n people costs exactly n - k
 * transfers, and n - k is minimal for that partition, so minimising transfers is
 * the same problem as MAXIMISING the number of disjoint zero-sum subgroups. That
 * is solved exactly here with a memoised bitmask DP over subsets.
 *
 * Pure module: no DOM, no storage, no globals.
 */

import { computePairwiseDebts } from './balances.js';

/** @typedef {{memberId: string, net: number}} Balance */
/** @typedef {{from: string, to: string, paise: number}} Transfer */

/**
 * Largest number of NON-ZERO members for which the exact search is run.
 *
 * The DP visits every (subset, sub-subset) pair, which is 3^n / 2 steps, and
 * allocates two arrays of 2^n entries. At n = 12 that is ~265k steps and 4,096
 * slots — well under a millisecond, invisible on a phone. Each extra member
 * triples the work (n = 16 would already be ~21M steps), and a group large
 * enough to hurt is also one where a plan of n-1 payments is perfectly
 * acceptable, so above this threshold we fall back to pure greedy matching.
 */
const EXACT_MAX_MEMBERS = 12;

/**
 * Build the shortest payment plan that zeroes every supplied balance.
 *
 * Exact (partition + greedy) for up to {@link EXACT_MAX_MEMBERS} non-zero
 * members whose balances reconcile to zero; greedy otherwise. The result is
 * deterministic: every tie is broken by `memberId`, so re-rendering the settle
 * screen never reshuffles the list.
 *
 * @param {Balance[]} balances
 * @returns {Transfer[]} each with a strictly positive integer `paise`
 */
export function minimiseTransfers(balances) {
  const members = nonZeroBalances(balances);
  if (members.length === 0) return [];

  const total = members.reduce((acc, member) => acc + member.net, 0);

  // The DP assumes the ledger reconciles; corrupt data that does not sum to
  // zero still deserves a plan, so it takes the greedy path.
  const exact = members.length <= EXACT_MAX_MEMBERS && total === 0;

  const transfers = [];
  if (exact) {
    for (const subgroup of maxZeroSumPartition(members)) {
      for (const transfer of greedyMatch(subgroup)) transfers.push(transfer);
    }
  } else {
    for (const transfer of greedyMatch(members)) transfers.push(transfer);
  }

  return sortTransfers(transfers);
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

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * Drop everything that cannot take part in a plan: malformed rows and members
 * with nothing to pay or receive. Duplicate ids are folded together so a
 * repeated row cannot make the same person appear twice in the search.
 *
 * @param {Balance[]} balances
 * @returns {Balance[]} sorted by memberId — the canonical order that every
 *   tie-break and every bit index below depends on.
 */
function nonZeroBalances(balances) {
  const totals = new Map();
  for (const balance of Array.isArray(balances) ? balances : []) {
    if (!balance || typeof balance.memberId !== 'string' || balance.memberId === '') continue;
    if (!Number.isInteger(balance.net)) continue;
    totals.set(balance.memberId, (totals.get(balance.memberId) || 0) + balance.net);
  }
  return [...totals]
    .filter((entry) => entry[1] !== 0)
    .map(([memberId, net]) => ({ memberId, net }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

/**
 * Partition `members` into as MANY disjoint zero-sum subgroups as possible.
 *
 * `dp[mask]` is the largest number of zero-sum subgroups the members in `mask`
 * can be cut into; it is only meaningful for masks that themselves sum to zero.
 * `choice[mask]` remembers which subgroup was taken first so the partition can
 * be replayed. Every candidate subgroup is forced to contain the lowest set bit
 * of `mask`, which avoids considering a subgroup and its complement twice and
 * makes the enumeration order stable.
 *
 * @param {Balance[]} members non-zero, sorted by memberId, summing to zero
 * @returns {Balance[][]} subgroups, each summing to exactly zero
 */
function maxZeroSumPartition(members) {
  const n = members.length;
  const full = (1 << n) - 1;

  // Net of every subset, built from the subset with its lowest member removed.
  const sums = new Float64Array(full + 1);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    sums[mask] = sums[mask ^ low] + members[31 - Math.clz32(low)].net;
  }

  const dp = new Int32Array(full + 1).fill(-1);
  const choice = new Int32Array(full + 1);
  dp[0] = 0;

  for (let mask = 1; mask <= full; mask++) {
    if (sums[mask] !== 0) continue; // cannot be cut into zero-sum groups at all
    const low = mask & -mask;
    const rest = mask ^ low;

    let best = -1;
    let bestPick = 0;
    // Every submask of `rest`, always together with `low`. Taking the whole of
    // `mask` (s === rest) is always a candidate, so `best` ends up >= 1.
    for (let s = rest; ; s = (s - 1) & rest) {
      const pick = s | low;
      if (sums[pick] === 0) {
        const remainder = mask ^ pick; // strictly smaller, so dp is already known
        const prior = dp[remainder];
        // `>=` keeps the SMALLEST winning pick: submasks are enumerated
        // downwards, so ties settle on the lowest member ids.
        if (prior >= 0 && prior + 1 >= best) {
          best = prior + 1;
          bestPick = pick;
        }
      }
      if (s === 0) break;
    }

    dp[mask] = best;
    choice[mask] = bestPick;
  }

  const groups = [];
  let mask = full;
  while (mask !== 0) {
    const pick = choice[mask];
    if (pick === 0) { // unreachable for a reconciled roster; never loop forever
      groups.push(membersOf(members, mask));
      break;
    }
    groups.push(membersOf(members, pick));
    mask ^= pick;
  }
  return groups;
}

/** The members of `mask`, in bit order (i.e. memberId order). */
function membersOf(members, mask) {
  const out = [];
  for (let i = 0; i < members.length; i++) {
    if (mask & (1 << i)) out.push(members[i]);
  }
  return out;
}

/**
 * Settle one set of balances by repeatedly paying the largest debt to the
 * largest credit. Produces at most `members.length - 1` transfers, and exactly
 * that many when the set holds no smaller zero-sum pocket.
 *
 * @param {Balance[]} members
 * @returns {Transfer[]}
 */
function greedyMatch(members) {
  const byAmountThenId = (a, b) => b.remaining - a.remaining || a.memberId.localeCompare(b.memberId);
  const creditors = members
    .filter((member) => member.net > 0)
    .map((member) => ({ memberId: member.memberId, remaining: member.net }))
    .sort(byAmountThenId);
  const debtors = members
    .filter((member) => member.net < 0)
    .map((member) => ({ memberId: member.memberId, remaining: -member.net }))
    .sort(byAmountThenId);

  const transfers = [];
  let creditor = 0;
  let debtor = 0;
  while (creditor < creditors.length && debtor < debtors.length) {
    const from = debtors[debtor];
    const to = creditors[creditor];
    const paise = Math.min(from.remaining, to.remaining);
    if (paise <= 0) break; // impossible with non-zero balances; never spin
    transfers.push({ from: from.memberId, to: to.memberId, paise });
    from.remaining -= paise;
    to.remaining -= paise;
    if (from.remaining === 0) debtor += 1;
    if (to.remaining === 0) creditor += 1;
  }
  return transfers;
}

/**
 * Stable, total order: biggest payment first, then by payer, then by payee.
 * A given (from, to) pair can occur only once — each greedy step exhausts one
 * side of it, and subgroups are disjoint — so this order is strict.
 */
function sortTransfers(transfers) {
  return transfers.sort((a, b) =>
    b.paise - a.paise
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to));
}
