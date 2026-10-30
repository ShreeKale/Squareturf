/*
 * "Install app" support for turf websites: web app manifest, service worker and a generated icon.
 * No image library is needed, the icon is drawn here and encoded as a PNG with Node's zlib.
 */
const zlib = require('zlib');
 
const ALLOWED_ICON_SIZES = new Set([180, 192, 512]);
 
/* ---------- Web app manifest ---------- */
 
/* base is '' on a turf's own subdomain, or '/turf/<slug>' when the site lives under a path */
function buildManifest(tenant, themeColor, base) {
  const name = String(tenant.name || 'Turf').slice(0, 45);
  const shortName = name.length > 12 ? name.slice(0, 12).trim() : name;
  const home = `${base}/`;
 
  return {
    id: home,
    name,
    short_name: shortName,
    description: `Book slots at ${name}.`,
    start_url: home,
    scope: home,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: themeColor,
    icons: [
      { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
 
/* ---------- Service worker ---------- */
 
/* Kept deliberately small: it makes the site installable and shows a friendly page when offline.
   Pages and API calls are never cached, so slots and logins are always live. */
const SERVICE_WORKER = `
const OFFLINE_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline</title><body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px;color:#262626">' +
  '<div><h1 style="font-size:20px;margin:0 0 8px">You are offline</h1><p style="margin:0 0 16px;color:#525252">Connect to the internet to see slots and book.</p>' +
  '<button onclick="location.reload()" style="border:0;border-radius:10px;background:#2563eb;color:#fff;padding:10px 18px;font-size:15px;font-weight:600">Try again</button></div>';
 
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
 
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
 
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_PAGE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }))
  );
});
`;
 
/* ---------- Icon ---------- */
 
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
 
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
 
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
 
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
 
  return Buffer.concat([head, data, tail]);
}
 
const hexToRgb = (hex) => {
  const value = parseInt(String(hex).replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
 
/* Is the point (x, y), in 0..1, on a white line of the football pitch drawing? */
function onPitchLine(x, y) {
  const line = 0.016; // half of the line width
  const left = 0.17, right = 0.83, top = 0.29, bottom = 0.71;
 
  const insideOuter = x >= left - line && x <= right + line && y >= top - line && y <= bottom + line;
  const insideInner = x > left + line && x < right - line && y > top + line && y < bottom - line;
  if (insideOuter && !insideInner) return true;                                   // touchlines
  if (insideInner && Math.abs(x - 0.5) <= line) return true;                       // halfway line
  if (Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.095) <= line) return true;        // centre circle
  if (insideInner && y > 0.4 && y < 0.6 && (x < left + 0.1 || x > right - 0.1)) {  // goal boxes
    return Math.abs(x - (x < 0.5 ? left + 0.1 : right - 0.1)) <= line || ((y < 0.4 + line || y > 0.6 - line) && true);
  }
  return false;
}
 
const iconCache = new Map();
 
/* A square PNG: the turf's theme colour with a white pitch drawing (kept inside the safe area for maskable icons) */
function buildIcon(size, themeColor) {
  const key = `${size}-${themeColor}`;
  if (iconCache.has(key)) return iconCache.get(key);
 
  const [r, g, b] = hexToRgb(themeColor);
  const rows = Buffer.alloc(size * (size * 3 + 1));
  const samples = [0.17, 0.5, 0.83]; // 3 x 3 samples per pixel for smooth edges
 
  for (let py = 0; py < size; py += 1) {
    const rowStart = py * (size * 3 + 1);
    rows[rowStart] = 0; // filter: none
 
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (const sy of samples) {
        for (const sx of samples) {
          if (onPitchLine((px + sx) / size, (py + sy) / size)) hits += 1;
        }
      }
      const mix = hits / 9;
      const at = rowStart + 1 + px * 3;
      rows[at] = Math.round(r + (255 - r) * mix);
      rows[at + 1] = Math.round(g + (255 - g) * mix);
      rows[at + 2] = Math.round(b + (255 - b) * mix);
    }
  }
 
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
 
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
 
  iconCache.set(key, png);
  return png;
}
 
module.exports = { ALLOWED_ICON_SIZES, SERVICE_WORKER, buildIcon, buildManifest };
 