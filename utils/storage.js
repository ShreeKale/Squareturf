const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/*
 * Where uploaded images are kept.
 *  - On Vercel (BLOB_READ_WRITE_TOKEN is set): Vercel Blob, because Vercel's disk is read-only.
 *  - On your own computer: public/uploads/<turfId>/ as before.
 */

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LOCAL_ROOT = path.join(PUBLIC_DIR, 'uploads');

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const isBlobUrl = (url) => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(String(url || ''));

/* Saves one multer memory file and returns the public URL to store on the turf */
async function saveImage(tenantId, file) {
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${EXTENSIONS[file.mimetype] || '.jpg'}`;

  if (useBlob()) {
    const { put } = require('@vercel/blob');
    const blob = await put(`turfs/${tenantId}/${name}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
      addRandomSuffix: false
    });
    return blob.url;
  }

  if (process.env.VERCEL) {
    throw new Error('Image storage is not set up. In Vercel, open Storage, create a Blob store and connect it to this project.');
  }

  const folder = path.join(LOCAL_ROOT, String(tenantId));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), file.buffer);
  return `/uploads/${tenantId}/${name}`;
}

/* Deletes an image, but only if it belongs to this turf. Never throws. */
async function removeImage(tenantId, url) {
  const value = String(url || '');

  try {
    if (isBlobUrl(value)) {
      if (!useBlob() || !value.includes(`/turfs/${tenantId}/`)) return;
      const { del } = require('@vercel/blob');
      await del(value);
      return;
    }

    if (!value.startsWith(`/uploads/${tenantId}/`)) return;

    const folder = path.join(LOCAL_ROOT, String(tenantId));
    const file = path.join(PUBLIC_DIR, value);
    if (file.startsWith(folder + path.sep)) fs.unlink(file, () => {});
  } catch (error) {
    console.error('Could not delete image:', error.message);
  }
}

module.exports = { saveImage, removeImage, EXTENSIONS };