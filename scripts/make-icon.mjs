// make-icon.mjs — unified brand mark for Launcher + App A. Zero dependencies.
// Mark: dark gradient rounded square, white diamond ring, sky accent core.
// (Ties the ◈ brand to the App A accent #0ea5e9; legible down to 16px.)
// Keep this file as the single source of truth; svg + png must match.
//
// Outputs:
//   launcher/resources/icon.png (256px — window/taskbar/exe via neutralino config)
//   public/app-icon.svg         (App A favicon via index.html)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SIZE = 256;
const CORNER_R = 0.27 * SIZE;
// Vertical gradient stops (top → bottom).
const GRAD_TOP = [44, 44, 50];
const GRAD_BOTTOM = [16, 16, 20];
const RING_OUTER = 0.31 * SIZE; // half-diagonal, L1 metric
const RING_INNER = 0.20 * SIZE;
const CORE_R = 0.095 * SIZE;
const ACCENT = [14, 165, 233];

function roundedRectSdf(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const hx = SIZE / 2;
  const hy = SIZE / 2;
  const qx = Math.abs(x - cx) - (hx - CORNER_R);
  const qy = Math.abs(y - cy) - (hy - CORNER_R);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - CORNER_R;
}

function diamondR(x, y) {
  return Math.abs(x - SIZE / 2) / 1 + Math.abs(y - SIZE / 2) / 1;
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function renderPng() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      // 2x2 supersample for smooth edges.
      let bg = 0;
      let ring = 0;
      let core = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = x + dx;
        const py = y + dy;
        if (roundedRectSdf(px, py) > 0) continue;
        bg += 1;
        const d = diamondR(px, py);
        if (d <= CORE_R) core += 1;
        else if (d <= RING_OUTER && d >= RING_INNER) ring += 1;
      }
      if (bg === 0) {
        raw[o++] = 0; raw[o++] = 0; raw[o++] = 0; raw[o++] = 0;
        continue;
      }
      const t = y / (SIZE - 1);
      const base = [
        GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t,
        GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t,
        GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t,
      ];
      const wRing = ring / 4;
      const wCore = core / 4;
      const wBase = Math.max(0, bg / 4 - wRing - wCore);
      // Subtle top light: lift the base color near the top edge.
      const lift = Math.max(0, 1 - y / (SIZE * 0.45)) * 10;
      raw[o++] = Math.round((base[0] * wBase + 255 * wRing + ACCENT[0] * wCore) / (bg / 4) + lift * (wBase / (bg / 4 || 1)));
      raw[o++] = Math.round((base[1] * wBase + 255 * wRing + ACCENT[1] * wCore) / (bg / 4) + lift * (wBase / (bg / 4 || 1)));
      raw[o++] = Math.round((base[2] * wBase + 255 * wRing + ACCENT[2] * wCore) / (bg / 4) + lift * (wBase / (bg / 4 || 1)));
      raw[o++] = Math.round((bg / 4) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

function renderSvg() {
  const c = SIZE / 2;
  const dia = (r) => `${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#2c2c32"/><stop offset="1" stop-color="#101014"/>` +
    `</linearGradient>` +
    `<mask id="ring"><rect width="256" height="256" fill="black"/>` +
    `<polygon points="${dia(RING_OUTER)}" fill="white"/>` +
    `<polygon points="${dia(RING_INNER)}" fill="black"/></mask></defs>` +
    `<rect x="0" y="0" width="256" height="256" rx="69" fill="url(#g)"/>` +
    `<polygon points="${dia(RING_OUTER)}" fill="white" mask="url(#ring)"/>` +
    `<polygon points="${dia(CORE_R)}" fill="#0ea5e9"/>` +
    `</svg>\n`;
}

const pngPath = join(ROOT, 'launcher', 'resources', 'icon.png');
const svgPath = join(ROOT, 'public', 'app-icon.svg');
mkdirSync(dirname(pngPath), { recursive: true });
mkdirSync(dirname(svgPath), { recursive: true });
writeFileSync(pngPath, renderPng());
writeFileSync(svgPath, renderSvg());
console.log(`wrote ${pngPath}`);
console.log(`wrote ${svgPath}`);
