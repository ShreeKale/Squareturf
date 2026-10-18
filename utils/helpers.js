const RESERVED_SLUGS = new Set([
  'www', 'admin', 'api', 'app', 'localhost', 'mail', 'support', 'dashboard'
]);

/* 3-40 characters: letters, numbers and hyphens, no hyphen at either end */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const SPORTS = ['Cricket', 'Box Cricket', 'Football', 'Futsal', 'Badminton', 'Other'];

/* Basic plan limit for now. Plan limits are enforced in a later step. */
const MAX_PHOTOS = 10;
const MAX_SERVICES = 12;
const MAX_SLOTS_PER_REQUEST = 24;

const pad = (number) => String(number).padStart(2, '0');

/* Wraps an async route so errors reach the error handler without try/catch */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function cleanSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function getLocalDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function getLocalTimeString() {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function toMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function toTimeString(totalMinutes) {
  return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

/* One-hour slots between opening and closing time */
function makeHourlySlots(openingTime, closingTime) {
  const start = toMinutes(openingTime);
  const end = toMinutes(closingTime);

  if (start === null || end === null || end <= start) return [];

  const slots = [];
  for (let minutes = start; minutes + 60 <= end; minutes += 60) {
    slots.push({
      startTime: toTimeString(minutes),
      endTime: toTimeString(minutes + 60)
    });
  }
  return slots;
}

/* Two time ranges clash when each one starts before the other ends */
function overlaps(a, b) {
  return a.startTime < b.endTime && a.endTime > b.startTime;
}

function slotKey(slot) {
  return `${slot.startTime}-${slot.endTime}`;
}

/* Clean the slots sent by a customer: trim, drop duplicates, sort by start time */
function normalizeSlots(slots) {
  const seen = new Set();
  const result = [];

  for (const slot of slots) {
    const startTime = String(slot?.startTime || '').trim();
    const endTime = String(slot?.endTime || '').trim();
    if (!startTime || !endTime) continue;

    const key = slotKey({ startTime, endTime });
    if (seen.has(key)) continue;

    seen.add(key);
    result.push({ startTime, endTime });
  }

  return result.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/* Photos: one URL per line */
function parseImages(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, MAX_PHOTOS);
}

/* Facilities: a JSON list of { name, icon, description } */
function parseServices(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Facilities must be valid JSON. Check commas and quotes.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Facilities must be a list, starting with [ and ending with ].');
  }

  return parsed
    .filter((item) => item && String(item.name || '').trim())
    .slice(0, MAX_SERVICES)
    .map((item) => ({
      name: String(item.name).trim().slice(0, 60),
      icon: String(item.icon || '').trim().slice(0, 4) || '✓',
      description: String(item.description || '').trim().slice(0, 120)
    }));
}

module.exports = {
  RESERVED_SLUGS,
  SLUG_PATTERN,
  SPORTS,
  MAX_SLOTS_PER_REQUEST,
  asyncHandler,
  cleanSlug,
    getLocalDateString,
  getLocalTimeString,
  isValidDateString,
  isValidTime,
  toMinutes,
  makeHourlySlots,
  overlaps,
  slotKey,
  normalizeSlots,
  parseImages,
  parseServices
};