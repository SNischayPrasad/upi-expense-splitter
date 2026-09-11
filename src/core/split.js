/**
 * split.js — turns a single expense into per-member shares.
 *
 * Six strategies (see SPLIT_TYPES) all obey the same contract: the returned
 * shares are integer paise that sum EXACTLY to `expense.amount`, in the same
 * order as `expense.participants`. All remainder handling is delegated to
 * money.js (`splitEvenly`, `allocateByWeights`) so that the odd paisa always
 * lands in the same, deterministic place across the whole app.
 *
 * Pure module: no DOM, no storage, no globals.
 */

import {
  MAX_PAISE,
  allocateByWeights,
  formatINR,
  splitEvenly,
  sum,
} from './money.js';

/** @typedef {{memberId: string, paise: number}} Share */
/** @typedef {{ok: true} | {ok: false, error: string}} SplitValidation */

/** Every split strategy the app understands, in the order the UI offers them. */
export const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized'];

/** Percentages are typed by humans, so allow a hair of slack around 100. */
const PERCENT_TOLERANCE = 0.01;

/** Shown by describeSplit when a member id cannot be resolved to a name. */
const UNKNOWN_NAME = 'one person';

const OK = Object.freeze({ ok: true });

/**
 * Compute the per-member shares for an expense.
 *
 * `splitData` shape by `splitType`:
 *   equal      : ignored (may be `{}` or omitted)
 *   exact      : `{ [memberId]: paise }`          must sum to `amount`
 *   percent    : `{ [memberId]: number }`         must sum to 100 (±0.01)
 *   shares     : `{ [memberId]: number }`         non-negative weights, e.g. `{a: 2, b: 1}`
 *   adjustment : `{ [memberId]: paise }`          signed per-head extra/less; the
 *                                                 remainder is split equally
 *   itemized   : `{ items: [{ id?, name, amount, participants }],
 *                   tax, tip, discount }`         each item splits equally among its own
 *                                                 participants; tax/tip/discount are
 *                                                 allocated pro-rata to each member's
 *                                                 pre-tax subtotal (discount subtracts)
 *
 * Entries in `splitData` for members who are not participants are ignored, so a
 * form that deselects someone does not have to prune its own state.
 *
 * @param {{amount: number, splitType: string, participants: string[], splitData?: object}} expense
 * @returns {Share[]} one entry per participant, in participant order, summing exactly to `expense.amount`
 * @throws {RangeError} with the human-readable message from {@link validateSplit} if the expense is malformed
 */
export function computeShares(expense) {
  const check = validateSplit(expense);
  if (!check.ok) throw new RangeError(check.error);

  const roster = expense.participants;
  const data = asRecord(expense.splitData);
  const paise = STRATEGIES[expense.splitType](expense.amount, roster, data);

  return roster.map((memberId, i) => ({ memberId, paise: paise[i] }));
}

/**
 * Validate an expense's split before it is computed or committed.
 * Every `error` is a complete, friendly sentence that the UI can show verbatim.
 *
 * @param {{amount: number, splitType: string, participants: string[], splitData?: object}} expense
 * @returns {SplitValidation}
 */
export function validateSplit(expense) {
  if (!isRecord(expense)) return fail('This expense is missing its details.');

  const { amount, splitType, participants } = expense;

  if (!Number.isInteger(amount)) {
    return fail('The expense amount must be a whole number of paise.');
  }
  if (Math.abs(amount) > MAX_PAISE) {
    return fail('That amount is larger than this app can handle.');
  }
  if (typeof splitType !== 'string' || !SPLIT_TYPES.includes(splitType)) {
    return fail('That is not a way of splitting this app knows about.');
  }

  const rosterCheck = validateRoster(participants);
  if (!rosterCheck.ok) return rosterCheck;

  return VALIDATORS[splitType](amount, participants, expense.splitData);
}

/**
 * A short human label for an expense's split, e.g. "Split equally between 4",
 * "By shares (2:1:1)", "Itemised · 6 items". Never throws — it is only ever a
 * label, so malformed data degrades to a generic phrase.
 *
 * @param {object} expense
 * @param {Map<string, {name?: string}>|Record<string, {name?: string}>} [membersById]
 * @returns {string} a non-empty label
 */
export function describeSplit(expense, membersById) {
  if (!isRecord(expense)) return 'Not split yet';

  const roster = Array.isArray(expense.participants) ? expense.participants : [];
  const n = roster.length;
  const data = asRecord(expense.splitData);

  switch (expense.splitType) {
    case 'equal':
      if (n === 0) return 'Split equally';
      if (n === 1) return `All on ${nameOf(membersById, roster[0])}`;
      return `Split equally between ${n}`;

    case 'exact':
      return 'Exact amounts';

    case 'percent': {
      const values = roster.map((id) => data[id]).filter(isFiniteNumber);
      if (n === 0 || values.length !== n || n > 4) {
        return n > 0 ? `By percentage across ${n}` : 'By percentage';
      }
      return `By percentage (${values.map((v) => `${trimNumber(v)}%`).join(' / ')})`;
    }

    case 'shares': {
      const values = roster.map((id) => data[id]).filter(isFiniteNumber);
      if (n === 0 || values.length !== n || n > 5) {
        return n > 0 ? `By shares across ${n}` : 'By shares';
      }
      return `By shares (${values.map(trimNumber).join(':')})`;
    }

    case 'adjustment': {
      const adjusted = roster.filter((id) => isFiniteNumber(data[id]) && data[id] !== 0);
      if (adjusted.length === 0) {
        return n > 0 ? `Split equally between ${n}` : 'Split equally';
      }
      if (adjusted.length === 1) return `Adjusted for ${nameOf(membersById, adjusted[0])}`;
      return `Adjusted for ${adjusted.length} people`;
    }

    case 'itemized': {
      const count = Array.isArray(data.items) ? data.items.length : 0;
      return `Itemised · ${count} ${count === 1 ? 'item' : 'items'}`;
    }

    default:
      return 'Custom split';
  }
}

/* ------------------------------------------------------------------ *
 * Strategies. Each returns number[] aligned with `roster`.
 * They may assume validateSplit has already passed.
 * ------------------------------------------------------------------ */

const STRATEGIES = {
  equal(amount, roster) {
    return splitEvenly(amount, roster.length);
  },

  exact(amount, roster, data) {
    return roster.map((id) => data[id]);
  },

  percent(amount, roster, data) {
    return allocateByWeights(amount, roster.map((id) => data[id]));
  },

  shares(amount, roster, data) {
    return allocateByWeights(amount, roster.map((id) => data[id]));
  },

  adjustment(amount, roster, data) {
    const adjustments = roster.map((id) => toOptionalNumber(data[id]) ?? 0);
    const evenly = splitEvenly(amount - sum(adjustments), roster.length);
    return adjustments.map((adj, i) => adj + evenly[i]);
  },

  itemized(amount, roster, data) {
    const indexOf = new Map(roster.map((id, i) => [id, i]));
    const items = data.items;

    // 1. Pre-tax subtotal per member: each item split equally among its own eaters.
    const subtotals = new Array(roster.length).fill(0);
    for (const item of items) {
      const eaters = item.participants;
      const parts = splitEvenly(item.amount, eaters.length);
      for (let k = 0; k < eaters.length; k++) {
        subtotals[indexOf.get(eaters[k])] += parts[k];
      }
    }

    // 2. Tax and tip add, discount subtracts; spread pro-rata over the subtotals.
    const { tax, tip, discount } = itemisedExtras(data);
    const extras = tax + tip - discount;
    let allocated;
    if (extras === 0) {
      allocated = new Array(roster.length).fill(0);
    } else if (sum(subtotals) === 0) {
      // Every item was free: there is no proportion to follow, so share equally.
      allocated = splitEvenly(extras, roster.length);
    } else {
      allocated = allocateByWeights(extras, subtotals);
    }

    return subtotals.map((paise, i) => paise + allocated[i]);
  },
};

/* ------------------------------------------------------------------ *
 * Validation. One validator per split type, each returning SplitValidation.
 * ------------------------------------------------------------------ */

const VALIDATORS = {
  equal: () => OK,
  exact: (amount, roster, raw) => validateExact(amount, roster, raw),
  percent: (amount, roster, raw) => validatePercent(roster, raw),
  shares: (amount, roster, raw) => validateShares(roster, raw),
  adjustment: (amount, roster, raw) => validateAdjustment(amount, roster, raw),
  itemized: (amount, roster, raw) => validateItemised(amount, roster, raw),
};

/** @returns {SplitValidation} */
function validateRoster(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    return fail('Pick at least one person to split this between.');
  }
  const seen = new Set();
  for (const id of participants) {
    if (typeof id !== 'string' || id.trim() === '') {
      return fail('One of the people in this split is missing an id.');
    }
    if (seen.has(id)) return fail('The same person is listed twice in this split.');
    seen.add(id);
  }
  return OK;
}

/** @returns {SplitValidation} */
function validateExact(amount, roster, raw) {
  if (!isRecord(raw)) return fail('Enter the exact amount each person owes.');

  let assigned = 0;
  for (const id of roster) {
    const value = raw[id];
    if (isBlank(value)) return fail('Everyone needs an exact amount before this can be saved.');
    if (!Number.isInteger(value)) {
      return fail('Exact amounts must be a whole number of paise.');
    }
    if (amount >= 0 && value < 0) return fail('An exact amount cannot be negative.');
    if (amount < 0 && value > 0) return fail('On a refund, every share must be zero or negative.');
    assigned += value;
  }

  if (assigned !== amount) return fail(reconcileMessage(amount, assigned, 'The amounts'));
  return OK;
}

/** @returns {SplitValidation} */
function validatePercent(roster, raw) {
  if (!isRecord(raw)) return fail('Enter the percentage each person owes.');

  let total = 0;
  for (const id of roster) {
    const value = raw[id];
    if (isBlank(value)) return fail('Everyone needs a percentage before this can be saved.');
    if (!isFiniteNumber(value)) return fail('Percentages must be numbers.');
    if (value < 0) return fail('A percentage cannot be negative.');
    total += value;
  }

  if (Math.abs(total - 100) > PERCENT_TOLERANCE) {
    const off = 100 - total;
    return fail(
      off > 0
        ? `The percentages add up to ${trimNumber(total)}% — ${trimNumber(off)}% is still left to assign.`
        : `The percentages add up to ${trimNumber(total)}% — that is ${trimNumber(-off)}% too much.`
    );
  }
  return OK;
}

/** @returns {SplitValidation} */
function validateShares(roster, raw) {
  if (!isRecord(raw)) return fail('Enter how many shares each person takes.');

  let total = 0;
  for (const id of roster) {
    const value = raw[id];
    if (isBlank(value)) return fail('Everyone needs a number of shares before this can be saved.');
    if (!isFiniteNumber(value)) return fail('Shares must be numbers.');
    if (value < 0) return fail('A number of shares cannot be negative.');
    total += value;
  }

  if (total <= 0) return fail('Someone needs at least one share — they cannot all be zero.');
  return OK;
}

/** @returns {SplitValidation} */
function validateAdjustment(amount, roster, raw) {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    return fail('The adjustments for this expense are not in a readable shape.');
  }
  const data = asRecord(raw);

  let adjustments = 0;
  for (const id of roster) {
    const value = data[id];
    if (isBlank(value)) continue; // No adjustment for this person is perfectly normal.
    if (!Number.isInteger(value)) {
      return fail('Adjustments must be a whole number of paise.');
    }
    adjustments += value;
  }

  const remainder = amount - adjustments;
  if (amount >= 0 && remainder < 0) {
    return fail(
      `The adjustments add up to ${formatINR(adjustments)}, which is more than the ${formatINR(amount)} total. ` +
        `Take ${formatINR(-remainder)} off them.`
    );
  }
  if (amount < 0 && remainder > 0) {
    return fail(
      `The adjustments add up to ${formatINR(adjustments)}, which is more than this refund of ${formatINR(amount)}.`
    );
  }
  return OK;
}

/** @returns {SplitValidation} */
function validateItemised(amount, roster, raw) {
  if (!isRecord(raw)) return fail('Add at least one item to split this bill.');

  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) {
    return fail('Add at least one item to split this bill.');
  }

  for (const [key, label] of [['tax', 'Tax'], ['tip', 'Tip'], ['discount', 'Discount']]) {
    const value = raw[key];
    if (isBlank(value)) continue;
    if (!Number.isInteger(value)) return fail(`${label} must be a whole number of paise.`);
    if (value < 0) return fail(`${label} cannot be negative.`);
  }

  const rosterSet = new Set(roster);
  let itemsTotal = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = itemLabel(item, i);

    if (!isRecord(item)) return fail(`Item ${i + 1} is missing its details.`);
    if (!Number.isInteger(item.amount)) return fail(`${label} needs an amount.`);
    if (item.amount < 0) return fail(`${label} cannot cost a negative amount.`);
    if (!Array.isArray(item.participants) || item.participants.length === 0) {
      return fail(`Nobody is sharing ${label} — pick at least one person.`);
    }

    const seen = new Set();
    for (const id of item.participants) {
      if (!rosterSet.has(id)) {
        return fail(`${label} is shared with someone who is not part of this expense.`);
      }
      if (seen.has(id)) return fail(`${label} lists the same person twice.`);
      seen.add(id);
    }

    itemsTotal += item.amount;
  }

  const { tax, tip, discount } = itemisedExtras(raw);
  const billTotal = itemsTotal + tax + tip - discount;
  if (billTotal !== amount) return fail(reconcileMessage(amount, billTotal, 'The items, tax and tip'));

  return OK;
}

/* ------------------------------------------------------------------ *
 * Small internal helpers
 * ------------------------------------------------------------------ */

/** Build the {ok:false} half of the validation result. */
function fail(error) {
  return { ok: false, error };
}

/**
 * One sentence explaining a total that does not reconcile, with both figures
 * formatted so the UI can show "₹20.00 is still left to assign".
 */
function reconcileMessage(expected, actual, subject) {
  const diff = expected - actual;
  return diff > 0
    ? `${subject} add up to ${formatINR(actual)} — ${formatINR(diff)} is still left to assign.`
    : `${subject} add up to ${formatINR(actual)} — that is ${formatINR(-diff)} more than the ${formatINR(expected)} total.`;
}

/** Tax, tip and discount default to zero when absent. */
function itemisedExtras(data) {
  return {
    tax: toOptionalNumber(data.tax) ?? 0,
    tip: toOptionalNumber(data.tip) ?? 0,
    discount: toOptionalNumber(data.discount) ?? 0,
  };
}

/** `"Pizza"` when the item is named, otherwise `item 3`. */
function itemLabel(item, index) {
  const name = isRecord(item) && typeof item.name === 'string' ? item.name.trim() : '';
  return name === '' ? `item ${index + 1}` : `"${name}"`;
}

/** Resolve a member id to a display name from a Map or a plain object. */
function nameOf(membersById, id) {
  if (!membersById || typeof id !== 'string') return UNKNOWN_NAME;
  const member = typeof membersById.get === 'function' ? membersById.get(id) : membersById[id];
  const name = isRecord(member) && typeof member.name === 'string' ? member.name.trim() : '';
  return name === '' ? UNKNOWN_NAME : name;
}

/** `2` -> "2", `33.333` -> "33.33". Keeps labels short without trailing zeros. */
function trimNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A record view of possibly-missing splitData, so lookups never throw. */
function asRecord(value) {
  return isRecord(value) ? value : {};
}

/** Empty form fields arrive as undefined, null or ''. */
function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Numbers pass through; blanks become undefined. Anything else is rejected upstream. */
function toOptionalNumber(value) {
  return isFiniteNumber(value) ? value : undefined;
}
