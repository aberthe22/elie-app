// Génère icon-192.png et icon-512.png — aucune dépendance npm
// USAGE : ouvre un terminal dans le dossier elie-app, puis tape :
//   node create-icon.js

'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (stdlib Node ≥ 22 ou fallback pur JS) ─────────────────────────────
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  // Fallback table-based CRC32
  if (!crc32._t) {
    crc32._t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32._t[i] = c;
    }
  }
  let v = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) v = crc32._t[(v ^ buf[i]) & 0xFF] ^ (v >>> 8);
  return (v ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG encoder ──────────────────────────────────────────────────────────────
function makePng(w, h, drawFn) {
  function u32(n) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  }
  function chunk(tag, data) {
    const tagBuf  = Buffer.from(tag, 'ascii');
    const payload = Buffer.concat([tagBuf, data]);
    return Buffer.concat([u32(data.length), payload, u32(crc32(payload))]);
  }

  const sig  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

  const hdrData = Buffer.allocUnsafe(13);
  hdrData.writeUInt32BE(w, 0);
  hdrData.writeUInt32BE(h, 4);
  hdrData[8]  = 8;  // bit depth
  hdrData[9]  = 2;  // color type: RGB
  hdrData[10] = 0; hdrData[11] = 0; hdrData[12] = 0;
  const ihdr = chunk('IHDR', hdrData);

  // Raw pixel data: filter byte (0x00) + RGB per pixel, per row
  const raw = Buffer.allocUnsafe(h * (1 + w * 3));
  let pos = 0;
  for (let y = 0; y < h; y++) {
    raw[pos++] = 0x00; // filter = None
    for (let x = 0; x < w; x++) {
      const px = drawFn(x, y, w, h);
      raw[pos++] = px[0];
      raw[pos++] = px[1];
      raw[pos++] = px[2];
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Icon design : cercle navy + étoile 4 branches or ────────────────────────
function drawElieIcon(x, y, w, h) {
  const cx = w / 2, cy = h / 2;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const r = w / 2;

  if (dist >= r) return [13, 26, 54]; // hors cercle

  const NAVY = [13, 26, 54];
  const GOLD = [212, 175, 55];

  // Étoile 4 branches : distance polaire modulée
  const angle  = Math.atan2(dy, dx);
  const seg    = Math.PI / 2;
  const sector = ((angle % seg) + seg) % seg;
  const t      = Math.abs(sector - seg / 2) / (seg / 2);
  const rOut   = r * 0.58;
  const rIn    = r * 0.09;
  const edge   = rIn + (rOut - rIn) * t;

  if (dist < edge) {
    const blend = Math.max(0, 1 - dist / edge);
    return [
      Math.round(NAVY[0] + (GOLD[0] - NAVY[0]) * blend),
      Math.round(NAVY[1] + (GOLD[1] - NAVY[1]) * blend),
      Math.round(NAVY[2] + (GOLD[2] - NAVY[2]) * blend),
    ];
  }

  // Anneau fin doré à 80% du rayon
  const ringDist = Math.abs(dist - r * 0.80);
  const ringW    = r * 0.034;
  if (ringDist < ringW) {
    const blend = (1 - ringDist / ringW) * 0.55;
    return [
      Math.round(NAVY[0] + (GOLD[0] - NAVY[0]) * blend),
      Math.round(NAVY[1] + (GOLD[1] - NAVY[1]) * blend),
      Math.round(NAVY[2] + (GOLD[2] - NAVY[2]) * blend),
    ];
  }

  return NAVY;
}

// ── Génération ───────────────────────────────────────────────────────────────
const dir = __dirname;
[192, 512].forEach(function(size) {
  const buf  = makePng(size, size, drawElieIcon);
  const file = path.join(dir, 'icon-' + size + '.png');
  fs.writeFileSync(file, buf);
  console.log('OK : ' + file + ' (' + buf.length + ' octets)');
});
console.log('\nIcones PNG creees. Tu peux maintenant supprimer create-icon.js');
