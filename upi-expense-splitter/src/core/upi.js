/** UPI URI construction and defensive parsing. */
import { paiseToUpiAmount } from './money.js';

export const UPI_HANDLES = Object.freeze([
  'upi', 'ybl', 'okaxis', 'okhdfcbank', 'oksbi', 'okicici', 'paytm', 'ibl', 'axl', 'fbl', 'apl', 'sbi', 'hdfcbank', 'icici', 'axisbank', 'kotak', 'idfcbank',
]);

const VPA = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/i;

export function validateVpa(vpa) {
  const normalized = typeof vpa === 'string' ? vpa.trim().toLowerCase() : '';
  if (!normalized) return { ok: false, error: 'Enter a UPI ID.' };
  if (normalized.length > 320 || !VPA.test(normalized)) return { ok: false, error: 'Use a UPI ID like name@bank.' };
  return { ok: true, normalized };
}

export function buildUpiUri(params = {}) {
  const vpa = validateVpa(params.pa);
  if (!vpa.ok) throw new RangeError(vpa.error);
  const name = clean(params.pn, 80);
  if (!name) throw new RangeError('A payee name is required.');
  if (!Number.isInteger(params.am) || params.am <= 0) throw new RangeError('UPI payments need a positive whole-paise amount.');
  const query = new URLSearchParams({ pa: vpa.normalized, pn: name, am: paiseToUpiAmount(params.am), cu: 'INR' });
  const note = clean(params.tn, 50).replace(/[\r\n]/g, ' ');
  const ref = clean(params.tr, 35).replace(/[^a-zA-Z0-9]/g, '');
  const merchantCode = clean(params.mc, 4).replace(/\D/g, '');
  if (note) query.set('tn', note);
  if (ref) query.set('tr', ref);
  if (merchantCode) query.set('mc', merchantCode);
  return `upi://pay?${query.toString()}`;
}

/** Common native payment app intents plus the universal UPI URI. */
export function buildAppLinks(params) {
  const universal = buildUpiUri(params);
  const query = universal.slice(universal.indexOf('?') + 1);
  return [
    { id: 'upi', name: 'Any UPI app', url: universal, color: '#5233c9' },
    { id: 'gpay', name: 'Google Pay', url: `tez://upi/pay?${query}`, color: '#4285f4' },
    { id: 'phonepe', name: 'PhonePe', url: `phonepe://pay?${query}`, color: '#5f259f' },
    { id: 'paytm', name: 'Paytm', url: `paytmmp://pay?${query}`, color: '#00baf2' },
  ];
}

export function parseUpiUri(uri) {
  if (typeof uri !== 'string') throw new RangeError('Enter a UPI payment link.');
  let url;
  try { url = new URL(uri.trim()); } catch { throw new RangeError('That is not a valid UPI payment link.'); }
  if (url.protocol !== 'upi:' || url.hostname !== 'pay') throw new RangeError('Expected a upi://pay link.');
  const pa = url.searchParams.get('pa') || '';
  const validation = validateVpa(pa);
  if (!validation.ok) throw new RangeError(validation.error);
  const am = url.searchParams.get('am');
  const paise = am && /^\d+(?:\.\d{1,2})?$/.test(am) ? Math.round(Number(am) * 100) : null;
  return { pa: validation.normalized, pn: url.searchParams.get('pn') || '', am: paise, tn: url.searchParams.get('tn') || '', tr: url.searchParams.get('tr') || '', mc: url.searchParams.get('mc') || '', cu: url.searchParams.get('cu') || 'INR' };
}

export function settlementRef(groupId, transfer) {
  const seed = `${groupId || 'group'}|${transfer?.from || ''}|${transfer?.to || ''}|${transfer?.paise || 0}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `SPU${(hash >>> 0).toString(36).toUpperCase()}`.slice(0, 35);
}

function clean(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
