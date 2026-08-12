/**
 * Generates the app icons as PNGs, with no image library.
 *
 * The mark is the same one used in the favicon: a T whose crossbar is a
 * price step, in amber on a near-black tile. It is three rectangles, so it is
 * drawn analytically with an exact box coverage test rather than approximated
 * — which is why it stays crisp at 16px and at 512px alike.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');

/* ----------------------------- PNG encoding ----------------------------- */

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
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode raw RGBA pixels (size × size) as a PNG buffer. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace — all zero.

  // One filter byte (0 = None) in front of every scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- geometry ------------------------------- */

/** Signed distance to a rounded rectangle centred in a size × size box. */
function sdRoundedBox(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 0 → fully outside, 1 → fully inside, smooth across one pixel. */
const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance));

const AMBER = [245, 165, 36];
const TILE = [11, 11, 12];

/**
 * The mark, in its own 32×32 space: a T whose crossbar is a price step.
 * Left arm low, right arm high, stem dropping from the join.
 */
const MARK = [
  [2, 11, 11.5, 4.5],
  [18, 5, 12, 4.5],
  [13.5, 5, 4.5, 24],
];
/** The bounding box of the three bars, used to centre and scale them. */
const MARK_BOX = { x: 2, y: 5, w: 28, h: 24 };

/**
 * Exact coverage of one pixel by an axis-aligned rectangle: the area of the
 * intersection. Analytic anti-aliasing, no sampling.
 */
function boxCoverage(px, py, x, y, w, h) {
  const dx = Math.min(px + 1, x + w) - Math.max(px, x);
  const dy = Math.min(py + 1, y + h) - Math.max(py, y);
  return dx <= 0 || dy <= 0 ? 0 : dx * dy;
}

function drawIcon(size, { padding = 0 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 32;
  const inset = padding * size;
  const half = size / 2 - inset;
  const radius = 7 * scale;

  // Fit the mark inside the tile with even breathing room on all sides.
  const room = (size - inset * 2) * 0.58;
  const markScale = Math.min(room / MARK_BOX.w, room / MARK_BOX.h);
  const offsetX = size / 2 - (MARK_BOX.x + MARK_BOX.w / 2) * markScale;
  const offsetY = size / 2 - (MARK_BOX.y + MARK_BOX.h / 2) * markScale;
  const bars = MARK.map(([x, y, w, h]) => [
    x * markScale + offsetX,
    y * markScale + offsetY,
    w * markScale,
    h * markScale,
  ]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tile = coverage(sdRoundedBox(x + 0.5 - size / 2, y + 0.5 - size / 2, half, radius));
      if (tile <= 0) continue;

      // The bars never overlap, so the coverages simply add.
      let mark = 0;
      for (const [bx, by, bw, bh] of bars) mark += boxCoverage(x, y, bx, by, bw, bh);
      mark = Math.min(1, mark);

      const offset = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) {
        rgba[offset + i] = Math.round(TILE[i] * (1 - mark) + AMBER[i] * mark);
      }
      rgba[offset + 3] = Math.round(255 * tile);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // iOS draws its own mask over the home-screen icon, so this one is square
  // with the mark inset to survive the crop.
  ['apple-touch-icon.png', 180, { padding: 0 }],
  // Maskable icons need generous safe-zone padding for Android's shape masks.
  ['icon-maskable-512.png', 512, { padding: 0.1 }],
];

for (const [name, size, options] of targets) {
  const png = drawIcon(size, options);
  writeFileSync(path.join(OUT, name), png);
  console.log(`${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
