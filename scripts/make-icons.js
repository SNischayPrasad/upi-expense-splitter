/**
 * scripts/make-icons.js — generate the app icons with no dependencies.
 *
 * Draws the SplitUPI mark (a rupee glyph on an indigo→violet gradient rounded
 * square) into an RGBA buffer with 4× supersampling, then encodes it as a PNG
 * by hand: IHDR + IDAT (zlib-deflated scanlines) + IEND.
 *
 * Run with `node scripts/make-icons.js`. Output goes to assets/icons/.
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/icons/', import.meta.url));
const SS = 4; // supersampling factor

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an RGBA pixel buffer as a PNG.
 * @param {Uint8Array} rgba width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter byte; 0 = None keeps this simple
  // and the deflate pass still compresses the flat gradient well.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/** Linear interpolation between two [r,g,b] colours. */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Is (x, y) inside a rounded rectangle? Coordinates are in unit space (0..1). */
function inRoundedRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Distance from point (px,py) to the segment (ax,ay)-(bx,by). */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Sample a quadratic Bezier into straight segments, so the glyph's bowl and leg
 * can be curved without needing a real path rasteriser.
 * @returns {number[][]} array of [ax, ay, bx, by] segments
 */
function quad(p0, c, p1, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ]);
  }
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
  }
  return segs;
}

/**
 * The rupee glyph ₹, drawn as stroked segments in unit space (y grows downward).
 *
 * Structure of the real symbol: two parallel horizontal bars across the top, a
 * short vertical stem hanging from the left of them, a bowl curving out to the
 * right and back, and a diagonal leg descending to the lower right.
 */
const GLYPH_STROKE = 0.072;
const GLYPH_SEGMENTS = [
  [0.30, 0.255, 0.72, 0.255],   // top bar
  [0.30, 0.375, 0.72, 0.375],   // second bar
  [0.385, 0.255, 0.385, 0.545], // left stem
  ...quad([0.385, 0.375], [0.66, 0.42], [0.415, 0.545]), // bowl
  ...quad([0.415, 0.545], [0.55, 0.62], [0.70, 0.775]),  // diagonal leg
];

/**
 * Render one icon.
 * @param {number} size pixel size
 * @param {{maskable?: boolean}} opts maskable icons keep art inside the safe zone
 * @returns {Uint8Array} RGBA buffer
 */
function renderIcon(size, opts = {}) {
  const { maskable = false } = opts;
  const rgba = new Uint8Array(size * size * 4);

  const from = [99, 102, 241]; // indigo-500
  const to = [168, 85, 247]; // purple-500

  // Maskable icons are cropped to a circle by the OS, so shrink the art into
  // the 80% safe zone and let the gradient bleed to the full square.
  const inset = maskable ? 0.1 : 0;
  const cornerRadius = maskable ? 0.5 : 0.28;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / size;
          const uy = (y + (sy + 0.5) / SS) / size;

          // Background plate
          const plateX = maskable ? ux : ux;
          const plateY = maskable ? uy : uy;
          const insidePlate = maskable
            ? true // full bleed; the OS mask does the rounding
            : inRoundedRect(plateX, plateY, cornerRadius);

          if (!insidePlate) continue;

          const base = mix(from, to, Math.min(1, (ux + uy) / 2));

          // Glyph, mapped into the safe zone for maskable variants
          const gx = (ux - inset) / (1 - 2 * inset);
          const gy = (uy - inset) / (1 - 2 * inset);

          let onGlyph = false;
          if (gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1) {
            for (const [ax, ay, bx, by] of GLYPH_SEGMENTS) {
              if (distToSegment(gx, gy, ax, ay, bx, by) <= GLYPH_STROKE / 2) {
                onGlyph = true;
                break;
              }
            }
          }

          const px = onGlyph ? [255, 255, 255] : base;
          r += px[0];
          g += px[1];
          b += px[2];
          a += 255;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      const cover = a / samples / 255;
      if (cover > 0) {
        rgba[i] = Math.round(r / (a / 255));
        rgba[i + 1] = Math.round(g / (a / 255));
        rgba[i + 2] = Math.round(b / (a / 255));
        rgba[i + 3] = Math.round(cover * 255);
      }
    }
  }

  return rgba;
}

/* ------------------------------------------------------------------ *
 * SVG variants (favicon + social card)
 * ------------------------------------------------------------------ */

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="SplitUPI">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 9.5h10"/>
    <path d="M11 13.5h10"/>
    <path d="M11 9.5c4.2 0 6.2 1.6 6.2 4s-2 4-6.2 4h-0.2l7.2 7"/>
  </g>
</svg>
`;

const OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="SplitUPI — split bills, settle over UPI">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="55%" stop-color="#312e81"/>
      <stop offset="100%" stop-color="#4c1d95"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1040" cy="120" r="260" fill="#6366f1" opacity="0.18"/>
  <circle cx="120" cy="560" r="200" fill="#a855f7" opacity="0.16"/>
  <rect x="88" y="150" width="120" height="120" rx="34" fill="url(#mark)"/>
  <g transform="translate(88 150)" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M40 36h44"/>
    <path d="M40 52h44"/>
    <path d="M40 36c18 0 27 7 27 17s-9 17-27 17h-1l31 30"/>
  </g>
  <text x="240" y="242" font-family="Segoe UI, Inter, system-ui, sans-serif" font-size="82" font-weight="700" fill="#ffffff">SplitUPI</text>
  <text x="88" y="378" font-family="Segoe UI, Inter, system-ui, sans-serif" font-size="52" font-weight="600" fill="#e0e7ff">Split bills. Settle in one tap over UPI.</text>
  <text x="88" y="452" font-family="Segoe UI, Inter, system-ui, sans-serif" font-size="32" fill="#a5b4fc">Minimal settlements · UPI deep links &amp; QR · Works offline · No account</text>
  <g transform="translate(88 500)">
    <rect width="340" height="62" rx="31" fill="#ffffff" opacity="0.12"/>
    <text x="30" y="40" font-family="Segoe UI, Inter, system-ui, sans-serif" font-size="26" fill="#ffffff">₹ upi://pay — one tap</text>
  </g>
</svg>
`;

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

await mkdir(OUT, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const t of targets) {
  const png = encodePng(renderIcon(t.size, { maskable: t.maskable }), t.size, t.size);
  await writeFile(new URL(t.name, `file://${OUT.replace(/\\/g, '/')}`), png);
  console.log(`wrote ${t.name} (${t.size}×${t.size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

await writeFile(new URL('favicon.svg', `file://${OUT.replace(/\\/g, '/')}`), FAVICON_SVG, 'utf8');
await writeFile(new URL('og-image.svg', `file://${OUT.replace(/\\/g, '/')}`), OG_SVG, 'utf8');
console.log('wrote favicon.svg, og-image.svg');
