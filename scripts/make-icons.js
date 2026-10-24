// Vygeneruje PNG ikony PWA (žlutý čtverec se znakem %) bez závislostí.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const YELLOW = [255, 216, 58];
const INK = [21, 24, 26];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Vzdálenost bodu od úsečky
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Pokrytí znaku % v jednotkových souřadnicích (0..1)
function glyph(x, y) {
  const ring = (cx, cy) => {
    const d = Math.hypot(x - cx, y - cy);
    return d < 0.15 && d > 0.07;
  };
  const slash = segDist(x, y, 0.69, 0.27, 0.31, 0.73) < 0.052;
  return ring(0.31, 0.31) || ring(0.69, 0.69) || slash;
}

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function png(size, { maskable }) {
  const S = 3;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size;
        const y = (py + (sy + 0.5) / S) / size;
        const inside = maskable ? true : inRoundedSquare(x, y, 0.2);
        if (!inside) continue;
        // maskable: obsah v bezpečné zóně (80 %)
        const gx = maskable ? (x - 0.1) / 0.8 : x;
        const gy = maskable ? (y - 0.1) / 0.8 : y;
        const c = glyph(gx, gy) ? INK : YELLOW;
        r += c[0]; g += c[1]; b += c[2]; a += 255;
      }
      const n = S * S;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const cov = a / 255;
      raw[o] = cov ? Math.round(r / cov) : 0;
      raw[o + 1] = cov ? Math.round(g / cov) : 0;
      raw[o + 2] = cov ? Math.round(b / cov) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('web/icons', { recursive: true });
writeFileSync('web/icons/icon-192.png', png(192, { maskable: false }));
writeFileSync('web/icons/icon-512.png', png(512, { maskable: false }));
writeFileSync('web/icons/icon-maskable-512.png', png(512, { maskable: true }));
writeFileSync(
  'web/icons/icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#ffd83a"/><g fill="none" stroke="#15181a" stroke-width="8"><circle cx="31" cy="31" r="11"/><circle cx="69" cy="69" r="11"/></g><path d="M69 27 31 73" stroke="#15181a" stroke-width="10.4" stroke-linecap="round"/></svg>\n`,
);
console.log('Ikony vytvořeny.');

// icon.ico pro instalátor, zástupce a odinstalaci: obrázky PNG v několika velikostech v jednom souboru ICO
{
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map((s) => png(s, { maskable: false }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // rezervováno
  header.writeUInt16LE(1, 2); // typ: ikona
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = Buffer.alloc(16 * sizes.length);
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s === 256 ? 0 : s; // 0 = 256
    dir[e + 1] = s === 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4); // roviny
    dir.writeUInt16LE(32, e + 6); // bity na pixel
    dir.writeUInt32LE(frames[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += frames[i].length;
  });
  writeFileSync('web/icons/icon.ico', Buffer.concat([header, dir, ...frames]));
  console.log('icon.ico vytvořen');
}
