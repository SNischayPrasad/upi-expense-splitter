/**
 * Compact, dependency-free QR encoder for payment intents.
 *
 * It implements byte-mode QR versions 1–10 and all ISO error-correction
 * levels. UPI intent URLs normally fit in these versions; callers get a useful
 * error instead of a silent, unscannable image if one does not.
 */

const ECC = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });
const ECC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/** Encode UTF-8 text into a QR module matrix. */
export function encodeQR(text, { ecc = 'M', minVersion = 1, maxVersion = 10 } = {}) {
  const level = String(ecc).toUpperCase();
  if (!(level in ECC)) throw new RangeError('QR error correction must be L, M, Q, or H.');
  const bytes = new TextEncoder().encode(String(text));
  minVersion = clampInt(minVersion, 1, 10);
  maxVersion = clampInt(maxVersion, minVersion, 10);
  let version = 0;
  for (let candidate = minVersion; candidate <= maxVersion; candidate += 1) {
    if (bytes.length <= byteCapacity(candidate, level)) { version = candidate; break; }
  }
  if (!version) throw new RangeError(`This payment link is too long for a QR code (max ${byteCapacity(maxVersion, level)} UTF-8 bytes at this error-correction level).`);
  const data = makeData(bytes, version, level);
  const matrix = new QrMatrix(version, level);
  matrix.drawCodewords(interleaveWithEcc(data, version, level));
  let bestMask = 0; let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    matrix.applyMask(mask); matrix.drawFormatBits(mask);
    const penalty = matrix.penalty();
    if (penalty < bestPenalty) { bestMask = mask; bestPenalty = penalty; }
    matrix.applyMask(mask);
  }
  matrix.applyMask(bestMask); matrix.drawFormatBits(bestMask);
  return { size: matrix.size, modules: matrix.modules.map((row) => row.slice()), version, ecc: level };
}

/** Render an encoded matrix as crisp standalone SVG. */
export function toSvg(qr, { moduleSize = 4, margin = 4, dark = '#000', light = '#fff' } = {}) {
  if (!qr || !Array.isArray(qr.modules) || !qr.modules.length) throw new RangeError('Provide an encoded QR matrix.');
  const size = qr.modules.length; const cell = Math.max(1, Math.trunc(moduleSize)); const pad = Math.max(0, Math.trunc(margin));
  const full = (size + pad * 2) * cell;
  let path = '';
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (qr.modules[y][x]) path += `M${(x + pad) * cell} ${(y + pad) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${full}" height="${full}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${escapeAttr(light)}"/><path d="${path}" fill="${escapeAttr(dark)}"/></svg>`;
}

/** Draw a QR matrix on a supplied canvas. */
export function toCanvas(qr, canvas, { moduleSize = 8, margin = 4, dark = '#000', light = '#fff' } = {}) {
  if (!canvas?.getContext) throw new TypeError('Provide a canvas element.');
  const size = qr?.modules?.length;
  if (!size) throw new RangeError('Provide an encoded QR matrix.');
  const cell = Math.max(1, Math.trunc(moduleSize)); const pad = Math.max(0, Math.trunc(margin)); const full = (size + pad * 2) * cell;
  canvas.width = full; canvas.height = full;
  const context = canvas.getContext('2d'); context.fillStyle = light; context.fillRect(0, 0, full, full); context.fillStyle = dark;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (qr.modules[y][x]) context.fillRect((x + pad) * cell, (y + pad) * cell, cell, cell);
  return canvas;
}

class QrMatrix {
  constructor(version, ecc) {
    this.version = version; this.ecc = ecc; this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.function = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.drawFunctionPatterns();
  }
  setFunction(x, y, dark) { this.modules[y][x] = dark; this.function[y][x] = true; }
  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i += 1) { this.setFunction(6, i, i % 2 === 0); this.setFunction(i, 6, i % 2 === 0); }
    this.drawFinder(3, 3); this.drawFinder(this.size - 4, 3); this.drawFinder(3, this.size - 4);
    const positions = alignmentPositions(this.version);
    for (let i = 0; i < positions.length; i += 1) for (let j = 0; j < positions.length; j += 1) {
      const skip = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
      if (!skip) this.drawAlignment(positions[i], positions[j]);
    }
    this.drawFormatBits(0); this.drawVersion();
  }
  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const xx = x + dx; const yy = y + dy; const distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, distance !== 2 && distance !== 4);
    }
  }
  drawAlignment(x, y) { for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  drawFormatBits(mask) {
    const data = (ECC[this.ecc] << 3) | mask; let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6)); this.setFunction(8, 8, bit(bits, 7)); this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, bit(bits, i));
    this.setFunction(8, this.size - 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, bit(bits, i));
    this.setFunction(8, this.size - 8, true);
  }
  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) { const dark = bit(bits, i); const a = this.size - 11 + (i % 3); const b = Math.floor(i / 3); this.setFunction(a, b, dark); this.setFunction(b, a, dark); }
  }
  drawCodewords(data) {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        const upward = ((right + 1) & 2) === 0; const y = upward ? this.size - 1 - vertical : vertical;
        for (let j = 0; j < 2; j += 1) { const x = right - j; if (!this.function[y][x] && index < data.length * 8) { this.modules[y][x] = bit(data[Math.floor(index / 8)], 7 - (index % 8)); index += 1; } }
      }
    }
  }
  applyMask(mask) {
    for (let y = 0; y < this.size; y += 1) for (let x = 0; x < this.size; x += 1) if (!this.function[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
  }
  penalty() {
    let score = 0;
    for (let y = 0; y < this.size; y += 1) score += linePenalty(this.modules[y]);
    for (let x = 0; x < this.size; x += 1) score += linePenalty(this.modules.map((row) => row[x]));
    for (let y = 0; y < this.size - 1; y += 1) for (let x = 0; x < this.size - 1; x += 1) if (this.modules[y][x] === this.modules[y][x + 1] && this.modules[y][x] === this.modules[y + 1][x] && this.modules[y][x] === this.modules[y + 1][x + 1]) score += 3;
    let dark = 0; for (const row of this.modules) for (const cell of row) if (cell) dark += 1;
    return score + Math.floor(Math.abs(dark * 20 - this.size * this.size * 10) / (this.size * this.size)) * 10;
  }
}

function byteCapacity(version, ecc) { const raw = rawCodewords(version); const data = raw - ECC_PER_BLOCK[ecc][version - 1] * BLOCKS[ecc][version - 1]; return data - 2 - (version < 10 ? 1 : 2); }
function makeData(bytes, version, ecc) {
  const capacity = rawCodewords(version) - ECC_PER_BLOCK[ecc][version - 1] * BLOCKS[ecc][version - 1]; const bits = [];
  appendBits(bits, 0x4, 4); appendBits(bits, bytes.length, version < 10 ? 8 : 16); for (const value of bytes) appendBits(bits, value, 8);
  appendBits(bits, 0, Math.min(4, capacity * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const out = []; for (let i = 0; i < bits.length; i += 8) { let value = 0; for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j]; out.push(value); }
  for (let pad = 0; out.length < capacity; pad += 1) out.push(pad % 2 ? 0x11 : 0xec); return out;
}
function interleaveWithEcc(data, version, ecc) {
  const numBlocks = BLOCKS[ecc][version - 1]; const eccLen = ECC_PER_BLOCK[ecc][version - 1]; const raw = rawCodewords(version); const shortLen = Math.floor(raw / numBlocks); const shortBlocks = numBlocks - (raw % numBlocks); let offset = 0;
  const dataBlocks = []; const eccBlocks = []; const divisor = rsDivisor(eccLen);
  for (let i = 0; i < numBlocks; i += 1) { const length = shortLen - eccLen + (i < shortBlocks ? 0 : 1); const block = data.slice(offset, offset + length); offset += length; dataBlocks.push(block); eccBlocks.push(rsRemainder(block, divisor)); }
  const out = []; const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < eccLen; i += 1) for (const block of eccBlocks) out.push(block[i]);
  return out;
}
function rsDivisor(degree) { const result = Array(degree).fill(0); result[degree - 1] = 1; let root = 1; for (let i = 0; i < degree; i += 1) { for (let j = 0; j < degree; j += 1) { result[j] = gfMultiply(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; } root = gfMultiply(root, 0x02); } return result; }
function rsRemainder(data, divisor) { const result = Array(divisor.length).fill(0); for (const value of data) { const factor = value ^ result.shift(); result.push(0); for (let i = 0; i < divisor.length; i += 1) result[i] ^= gfMultiply(divisor[i], factor); } return result; }
function gfMultiply(a, b) { let value = 0; for (let i = 0; i < 8; i += 1) { if ((b >>> i) & 1) value ^= a << i; } for (let i = 14; i >= 8; i -= 1) if ((value >>> i) & 1) value ^= 0x11d << (i - 8); return value; }
function rawCodewords(version) { return Math.floor(rawDataModules(version) / 8); }
function rawDataModules(version) { let result = (16 * version + 128) * version + 64; if (version >= 2) { const count = Math.floor(version / 7) + 2; result -= (25 * count - 10) * count - 55; if (version >= 7) result -= 36; } return result; }
function alignmentPositions(version) { if (version === 1) return []; const count = Math.floor(version / 7) + 2; const step = version === 32 ? 26 : Math.ceil((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2; const out = [6]; for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos); return out; }
function linePenalty(line) { let score = 0; let run = 1; for (let i = 1; i < line.length; i += 1) { if (line[i] === line[i - 1]) run += 1; else { if (run >= 5) score += 3 + run - 5; run = 1; } } if (run >= 5) score += 3 + run - 5; for (let i = 0; i <= line.length - 7; i += 1) { const found = line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6]; if (found) { const before = line.slice(Math.max(0, i - 4), i).every((cell) => !cell); const after = line.slice(i + 7, i + 11).every((cell) => !cell); if (before || after) score += 40; } } return score; }
function maskBit(mask, x, y) { switch (mask) { case 0: return (x + y) % 2 === 0; case 1: return y % 2 === 0; case 2: return x % 3 === 0; case 3: return (x + y) % 3 === 0; case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; case 5: return (x * y) % 2 + (x * y) % 3 === 0; case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0; default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0; } }
function appendBits(target, value, length) { for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1); }
function bit(value, index) { return ((value >>> index) & 1) !== 0; }
function clampInt(value, min, max) { const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min; return Math.max(min, Math.min(max, n)); }
function escapeAttr(value) { return String(value).replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char])); }
