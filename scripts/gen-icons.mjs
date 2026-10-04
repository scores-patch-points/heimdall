// Generates public/icons/icon-{192,512}.png (minimal PNG encoder, no deps).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The hive (256-unit design grid, the same geometry as icon.svg): four
// stacked rounded tiers of a skep and its entrance. Outlines are drawn by
// signed distance to each tier, supersampled so the PNG edges are smooth.
const TIERS = [
  [44, 168, 168, 40, 20],
  [60, 128, 136, 40, 20],
  [80, 88, 96, 40, 20],
  [104, 52, 48, 36, 18],
];
const STROKE = 16;

function sdRoundRect(px, py, [x, y, w, h, r]) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 1 = hive ink, 0 = background, null = not decided here.
function doorAt(u, v) {
  // the entrance: an arch opening cut into the bottom tier, outlined
  const inside = (u >= 110 && u <= 146 && v >= 190 && v <= 212) || (Math.hypot(u - 128, v - 190) <= 18 && v <= 190);
  const outer = (u >= 102 && u <= 154 && v >= 190 && v <= 212) || (Math.hypot(u - 128, v - 190) <= 26 && v <= 190);
  if (inside) return 0;
  if (outer) return 1;
  return null;
}

function inHive(u, v) {
  const door = doorAt(u, v);
  if (door != null) return door === 1;
  return TIERS.some((t) => Math.abs(sdRoundRect(u, v, t)) <= STROKE / 2);
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [0x0b, 0x0e, 0x14];
  const fg = [0xf2, 0xb5, 0x44];
  const k = 256 / size;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++)
          if (inHive((x + (sx + 0.5) / SS) * k, (y + (sy + 0.5) / SS) * k)) hit++;
      const a = hit / (SS * SS);
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.round(bg[ch] * (1 - a) + fg[ch] * a);
      px[i + 3] = 0xff;
    }
  }
  return px;
}

mkdirSync(join(root, "public/icons"), { recursive: true });
for (const size of [192, 512]) {
  const out = join(root, `public/icons/icon-${size}.png`);
  writeFileSync(out, png(size, render(size)));
  console.log("wrote", out);
}