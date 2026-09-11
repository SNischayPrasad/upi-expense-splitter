/**
 * recurring.js — expand recurring expense templates into concrete expenses.
 *
 * Rent on the 1st, the broadband bill on the 31st, chai money every second
 * Monday. A template carries the expense fields plus a rule:
 *
 *   { freq: 'daily'|'weekly'|'monthly', interval, dayOfMonth?, weekday?,
 *     startDate: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
 *
 * Every occurrence is anchored to `startDate`, never to the previous
 * occurrence, so a monthly rule for the 31st walks
 * 31 Jan -> 28 Feb -> 31 Mar rather than drifting to the 28th forever.
 *
 * All date arithmetic runs on ISO date strings through a proleptic Gregorian
 * day-number conversion, so no result depends on the machine's time zone and
 * `Date` is never consulted. The caller passes `asOf` explicitly.
 *
 * Pure module: no DOM, no storage, no clock.
 */

import { MAX_PAISE } from './money.js';

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

/** Largest accepted repeat interval (a rule every 366 days/weeks/months). */
const MAX_INTERVAL = 366;

/** Most occurrences one template may produce in a single expansion. */
const MAX_OCCURRENCES = 60;

/** Steps allowed while nudging an estimated occurrence index onto the real one. */
const SEARCH_LIMIT = 16;

/** Nothing is ever scheduled past this date. */
const MAX_DATE = '9999-12-31';

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Expand every recurring template in `group.recurring` into concrete expenses
 * dated after the template's `lastGeneratedAt` and on or before `asOf`.
 *
 * Each generated expense carries `recurringId` so the caller can record the new
 * `lastGeneratedAt` (the latest `date` per `recurringId`) after committing them.
 * Ids are deterministic (`<templateId>:<date>`), so running the expansion twice
 * with the same inputs produces the same expenses instead of duplicates.
 *
 * A template that is `active: false`, has an invalid rule, or has not started
 * yet yields nothing. Each template is capped at 60 occurrences per call so an
 * app left closed for a year cannot generate thousands in one go.
 *
 * @param {object} group a group whose optional `recurring` array holds templates
 * @param {string} asOf inclusive upper bound, 'YYYY-MM-DD' (a full ISO stamp or
 *   a Date is also accepted; a Date is read in local terms)
 * @returns {object[]} expenses sorted by date ascending, then by template order
 * @throws {RangeError} when `asOf` is missing or not a real date
 */
export function dueOccurrences(group, asOf) {
  const limit = toIsoDate(asOf);
  if (limit === null) {
    throw new RangeError('dueOccurrences needs an asOf date, e.g. "2026-09-11"');
  }

  const templates = group && Array.isArray(group.recurring) ? group.recurring : [];
  const out = [];

  templates.forEach((template, index) => {
    if (!isObject(template) || template.active === false) return;

    const rule = normalizeRule(isObject(template.rule) ? template.rule : template);
    if (rule === null) return;

    const amount = templateAmount(template);
    if (amount === null) return;

    const templateId = stringOr(template.id, `recurring-${index}`);
    const cursorStart = toIsoDate(template.lastGeneratedAt);

    let cursor = nextFrom(rule, cursorStart);
    let produced = 0;
    while (cursor !== null && cursor <= limit && produced < MAX_OCCURRENCES) {
      out.push(materialize(template, templateId, amount, cursor, index));
      produced += 1;
      cursor = nextFrom(rule, cursor);
    }
  });

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._order - b._order))
    .map(stripOrder);
}

/**
 * The first occurrence of `rule` strictly after `from`.
 *
 * @param {object} rule {freq, interval, dayOfMonth?, weekday?, startDate, endDate?}
 * @param {string} [from] 'YYYY-MM-DD'; when omitted or unparseable the rule's
 *   first occurrence is returned
 * @returns {string|null} 'YYYY-MM-DD', or null when the rule is invalid or has
 *   already ended
 */
export function nextDueDate(rule, from) {
  const normalized = normalizeRule(rule);
  if (normalized === null) return null;
  return nextFrom(normalized, toIsoDate(from));
}

/* ------------------------------------------------------------------ *
 * Rule handling
 * ------------------------------------------------------------------ */

/**
 * @typedef {{freq: string, interval: number, startDate: string, endDate: string|null,
 *            dayOfMonth: number, weekday: number|null, anchorDay: number,
 *            start: {y: number, m: number, d: number}}} NormalRule
 */

/**
 * Validate a rule and precompute its anchor.
 * @param {unknown} rule
 * @returns {NormalRule|null} null when the rule cannot be used
 */
function normalizeRule(rule) {
  if (!isObject(rule)) return null;
  if (!FREQUENCIES.has(rule.freq)) return null;

  const start = parseIso(rule.startDate);
  if (start === null) return null;

  const interval = Number.isFinite(rule.interval) ? Math.trunc(rule.interval) : 1;
  if (interval < 1 || interval > MAX_INTERVAL) return null;

  const endIso = toIsoDate(rule.endDate);
  const startIso = formatIso(start);
  if (endIso !== null && endIso < startIso) return null;

  const dayOfMonth = Number.isFinite(rule.dayOfMonth)
    ? clampInt(Math.trunc(rule.dayOfMonth), 1, 31)
    : start.d;

  const weekday = Number.isFinite(rule.weekday) ? clampInt(Math.trunc(rule.weekday), 0, 6) : null;

  const startDay = toDayNumber(start);
  const anchorDay =
    rule.freq === 'weekly' && weekday !== null
      ? startDay + (((weekday - weekdayOf(startDay)) % 7) + 7) % 7
      : startDay;

  return {
    freq: rule.freq,
    interval,
    startDate: startIso,
    endDate: endIso,
    dayOfMonth,
    weekday,
    anchorDay,
    start,
  };
}

/**
 * @param {NormalRule} rule
 * @param {string|null} from
 * @returns {string|null}
 */
function nextFrom(rule, from) {
  if (from === null) return withinEnd(rule, occurrenceIso(rule, 0));

  const firstGuess = Math.max(0, estimateIndex(rule, from));
  for (let step = 0; step <= SEARCH_LIMIT; step += 1) {
    const iso = occurrenceIso(rule, firstGuess + step);
    if (iso === null) return null;
    if (iso > from) return withinEnd(rule, iso);
  }
  return null;
}

/**
 * A lower bound on the occurrence index that lands on or before `from`.
 * @param {NormalRule} rule
 * @param {string} from 'YYYY-MM-DD'
 * @returns {number}
 */
function estimateIndex(rule, from) {
  const target = parseIso(from);
  if (target === null) return 0;

  if (rule.freq === 'monthly') {
    const months = (target.y - rule.start.y) * 12 + (target.m - rule.start.m);
    return Math.floor(months / rule.interval) - 1;
  }

  const stride = rule.freq === 'weekly' ? 7 * rule.interval : rule.interval;
  return Math.floor((toDayNumber(target) - rule.anchorDay) / stride);
}

/**
 * @param {NormalRule} rule
 * @param {number} index zero-based occurrence number
 * @returns {string|null} 'YYYY-MM-DD'
 */
function occurrenceIso(rule, index) {
  if (index < 0) return null;

  if (rule.freq === 'monthly') {
    const total = rule.start.y * 12 + (rule.start.m - 1) + index * rule.interval;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    if (y < 1 || y > 9999) return null;
    return formatIso({ y, m, d: Math.min(rule.dayOfMonth, daysInMonth(y, m)) });
  }

  const stride = rule.freq === 'weekly' ? 7 * rule.interval : rule.interval;
  const civil = fromDayNumber(rule.anchorDay + index * stride);
  if (civil.y < 1 || civil.y > 9999) return null;
  return formatIso(civil);
}

/**
 * @param {NormalRule} rule
 * @param {string|null} iso
 * @returns {string|null} the date, or null once the rule has ended
 */
function withinEnd(rule, iso) {
  if (iso === null || iso > MAX_DATE) return null;
  if (rule.endDate !== null && iso > rule.endDate) return null;
  return iso;
}

/* ------------------------------------------------------------------ *
 * Template -> expense
 * ------------------------------------------------------------------ */

/**
 * @param {object} template
 * @returns {number|null} integer paise, or null when the amount is unusable
 */
function templateAmount(template) {
  const amount = template.amount;
  if (!Number.isInteger(amount) || amount === 0) return null;
  if (Math.abs(amount) > MAX_PAISE) return null;
  return amount;
}

/**
 * Build one concrete expense from a template.
 * @param {object} template
 * @param {string} templateId
 * @param {number} amount integer paise
 * @param {string} date 'YYYY-MM-DD'
 * @param {number} order template position, used only to keep the sort stable
 * @returns {object}
 */
function materialize(template, templateId, amount, date, order) {
  const payers = Array.isArray(template.paidBy)
    ? template.paidBy
        .filter(isObject)
        .map((p) => ({ memberId: stringOr(p.memberId, ''), paise: Number.isInteger(p.paise) ? p.paise : 0 }))
        .filter((p) => p.memberId !== '')
    : [];

  return {
    id: `${templateId}:${date}`,
    recurringId: templateId,
    description: stringOr(template.description, 'Recurring expense'),
    amount,
    paidBy: payers.length > 0 ? payers : [{ memberId: '', paise: amount }],
    splitType: stringOr(template.splitType, 'equal'),
    participants: Array.isArray(template.participants)
      ? template.participants.filter((id) => typeof id === 'string' && id !== '')
      : [],
    splitData: isObject(template.splitData) ? { ...template.splitData } : {},
    category: stringOr(template.category, 'other'),
    date,
    notes: stringOr(template.notes, ''),
    createdAt: `${date}T00:00:00.000Z`,
    _order: order,
  };
}

/**
 * @param {object} expense
 * @returns {object} the same expense without the internal sort key
 */
function stripOrder(expense) {
  const { _order, ...rest } = expense;
  return rest;
}

/* ------------------------------------------------------------------ *
 * Time-zone-free civil date arithmetic
 * ------------------------------------------------------------------ */

/**
 * Accept an ISO date, an ISO stamp, or a Date and return 'YYYY-MM-DD'.
 * A Date is read through its local calendar fields, which is what "today"
 * means to the person using the app.
 * @param {unknown} value
 * @returns {string|null}
 */
function toIsoDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return formatIso({ y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() });
  }
  const parsed = parseIso(value);
  return parsed === null ? null : formatIso(parsed);
}

/**
 * @param {unknown} value 'YYYY-MM-DD' or anything starting with one
 * @returns {{y: number, m: number, d: number}|null}
 */
function parseIso(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match === null) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * @param {{y: number, m: number, d: number}} civil
 * @returns {string} 'YYYY-MM-DD'
 */
function formatIso(civil) {
  return `${String(civil.y).padStart(4, '0')}-${String(civil.m).padStart(2, '0')}-${String(civil.d).padStart(2, '0')}`;
}

/**
 * @param {number} y
 * @returns {boolean}
 */
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * @param {number} y
 * @param {number} m 1-12
 * @returns {number} 28..31
 */
function daysInMonth(y, m) {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1];
}

/**
 * Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's
 * days_from_civil). Exact integer arithmetic, no Date, no time zone.
 * @param {{y: number, m: number, d: number}} civil
 * @returns {number}
 */
function toDayNumber(civil) {
  const y = civil.m <= 2 ? civil.y - 1 : civil.y;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (civil.m + (civil.m > 2 ? -3 : 9)) + 2) / 5) + civil.d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Inverse of {@link toDayNumber}.
 * @param {number} dayNumber
 * @returns {{y: number, m: number, d: number}}
 */
function fromDayNumber(dayNumber) {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/**
 * @param {number} dayNumber
 * @returns {number} 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday)
 */
function weekdayOf(dayNumber) {
  return ((dayNumber % 7) + 11) % 7;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampInt(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
