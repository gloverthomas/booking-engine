// Generates the PWA icons in public/icons without any image dependency:
// a heavy black "R" (stem, bowl, leg) on brand peach, rasterised with 4x4 supersampling.
// Run with: node scripts/generate-pwa-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PEACH = [0xfd, 0xe9, 0xd6];
const INK = [0x14, 0x12, 0x10];

/** Coverage test for the letter R in a unit square [0,1]^2. */
function inR(x, y) {
  // Geometry in unit coordinates, glyph box roughly x 0.30..0.72, y 0.22..0.78
  const stem = x >= 0.3 && x <= 0.4 && y >= 0.22 && y <= 0.78;
  // Bowl: ring centred (0.5, 0.375), outer radius 0.155 vertical, flattened into a D on the right
  const cx = 0.5;
  const cy = 0.385;
  const ro = 0.165;
  const ri = 0.075;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  const bowl = x >= cx && d <= ro && d >= ri;
  const topBar = x >= 0.3 && x <= cx && y >= cy - ro && y <= cy - ri;
  const midBar = x >= 0.3 && x <= cx && y >= cy + ri && y <= cy + ro;
  // Leg: thick diagonal from the bowl's bottom to the lower right
  const ax = 0.48;
  const ay = 0.55;
  const bx = 0.7;
  const by = 0.78;
  const t = Math.max(
    0,
    Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
  );
  const leg = Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= 0.05;
  return stem || bowl || topBar || midBar || leg;
}

function render(size, scale) {
  const pixels = Buffer.alloc(size * size * 3);
  const ss = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const ux = (px + (sx + 0.5) / ss) / size;
          const uy = (py + (sy + 0.5) / ss) / size;
          // Scale the glyph about the centre so maskable icons keep it inside the safe zone.
          const gx = (ux - 0.5) / scale + 0.5;
          const gy = (uy - 0.5) / scale + 0.5;
          if (inR(gx, gy)) hits += 1;
        }
      }
      const a = hits / (ss * ss);
      const o = (py * size + px) * 3;
      for (let c = 0; c < 3; c += 1) pixels[o + c] = Math.round(PEACH[c] * (1 - a) + INK[c] * a);
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 3 + 1)] = 0;
    rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
const outputs = [
  ["icon-192.png", 192, 1.35],
  ["icon-512.png", 512, 1.35],
  // Maskable: platform may crop to a circle/squircle, keep the glyph inside the central 80%.
  ["icon-maskable-512.png", 512, 1.0],
  ["apple-touch-icon.png", 180, 1.2],
];
for (const [name, size, scale] of outputs) {
  writeFileSync(`public/icons/${name}`, png(size, render(size, scale)));
}
