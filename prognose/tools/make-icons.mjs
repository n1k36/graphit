/**
 * Generates the app icons as PNGs, with no image library.
 *
 * The mark is the same one used in the favicon: a rounded blue tile with a
 * white "rising chart" polyline. Everything is drawn analytically from signed
 * distances, which gives clean anti-aliasing without supersampling.
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

/** Distance from a point to a line segment. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/** 0 → fully outside, 1 → fully inside, smooth across one pixel. */
const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance));

const BLUE = [45, 127, 255];
const DEEP = [12, 74, 173];
/** The favicon polyline, in its original 32×32 space. */
const PATH = [
  [7, 21],
  [13, 14],
  [18, 18],
  [25, 9],
];

function drawIcon(size, { padding = 0 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 32;
  const inset = padding * size;
  const half = size / 2 - inset;
  const radius = 8 * scale;
  const strokeHalf = (2.8 * scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      const tile = coverage(sdRoundedBox(cx - size / 2, cy - size / 2, half, radius));
      if (tile <= 0) continue;

      // A subtle diagonal gradient so the tile is not a flat slab.
      const t = (cx + cy) / (2 * size);
      const bg = [0, 1, 2].map((i) => Math.round(BLUE[i] * (1 - t) + DEEP[i] * t));

      // Distance to the polyline, with round joins and caps for free.
      let line = Infinity;
      for (let i = 0; i < PATH.length - 1; i++) {
        const [ax, ay] = PATH[i];
        const [bx, by] = PATH[i + 1];
        line = Math.min(line, sdSegment(cx, cy, ax * scale, ay * scale, bx * scale, by * scale));
      }
      const stroke = coverage(line - strokeHalf);

      const offset = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) rgba[offset + i] = Math.round(bg[i] * (1 - stroke) + 255 * stroke);
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
