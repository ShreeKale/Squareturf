const RESERVED_SLUGS = new Set([
  'www', 'admin', 'api', 'app', 'localhost', 'mail', 'support', 'dashboard'
]);

/* 3-40 characters: letters, numbers and hyphens, no hyphen at either end */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const SPORTS = [
  'Cricket', 'Box Cricket', 'Football', 'Futsal', 'Badminton', 'Tennis',
  'Pickleball', 'Basketball', 'Volleyball', 'Table Tennis', 'Hockey', 'Other'
];
const MAX_SPORTS = 6;

/* Ground surface and size units */
const SURFACES = [
  'Artificial grass', 'Natural grass', 'Hybrid grass', 'Concrete', 'Clay',
  'Rubber / acrylic', 'Wooden floor', 'Sand', 'Other'
];
const SIZE_UNITS = [['ft', 'Feet'], ['m', 'Metres'], ['yd', 'Yards']];

/* Facilities an owner can tick. They are saved as the turf's facilities, with this description. */
const FACILITIES = [
  { name: 'Parking',          description: 'Convenient parking available.' },
  { name: 'Restroom',         description: 'Clean restroom facility.' },
  { name: 'Floodlights',      description: 'Evening and night play supported.' },
  { name: 'Changing room',    description: 'Change and keep your bags safe.' },
  { name: 'Drinking water',   description: 'Drinking water available.' },
  { name: 'Equipment rental', description: 'Balls, bibs and cones on request.' },
  { name: 'First aid',        description: 'Basic first aid kit on site.' },
  { name: 'Seating area',     description: 'Sit and watch the game.' },
  { name: 'Cafe / snacks',    description: 'Snacks and drinks nearby.' },
  { name: 'Wi-Fi',            description: 'Free Wi-Fi for players.' }
];

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

/*
 * Phone numbers: accepts "98765 43210", "+91 98765-43210" or "098765 43210".
 * Returns the 10 digits, or null when it is not a valid number.
 */
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return /^\d{10}$/.test(digits) ? digits : null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ''));
}

/*
 * Joins back-to-back hours of one date into a single session
 * (6-7 pm + 7-8 pm => 6-8 pm), newest date first.
 */
function groupConsecutive(bookings) {
  const sorted = [...bookings].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
  );
  const groups = [];

  for (const booking of sorted) {
    const last = groups[groups.length - 1];
    const continues =
      last &&
      last.date === booking.date &&
      last.status === booking.status &&
      last.paymentStatus === booking.paymentStatus &&
      last.endTime === booking.startTime;

    if (continues) {
      last.endTime = booking.endTime;
      last.amount += booking.amount;
    } else {
      groups.push({
        date: booking.date,
        startTime: booking.startTime,
        endTime: booking.endTime,
        amount: booking.amount,
        status: booking.status,
        paymentStatus: booking.paymentStatus
      });
    }
  }

  for (const group of groups) {
    group.hours = (toMinutes(group.endTime) - toMinutes(group.startTime)) / 60;
  }

  return groups.sort(
    (a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime)
  );
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

/*
 * Sports from the sign-up form: the ticked sports, where "Other" is replaced by the names typed in
 * (comma separated). Returns { sports } or { error }.
 */
function readSports(body) {
  const ticked = [...new Set([].concat(body.sports || []).map(String))];
  const chosen = ticked.filter((sport) => SPORTS.includes(sport) && sport !== 'Other');

  if (ticked.includes('Other')) {
    const custom = String(body.otherSport || '')
      .split(',')
      .map((name) => name.trim().replace(/\s+/g, ' ').slice(0, 30))
      .filter(Boolean);

    if (!custom.length) return { error: 'You ticked "Other". Please type the sport name.' };
    for (const name of custom) {
      if (!/^[\p{L}\p{N} .&'+\/-]+$/u.test(name)) return { error: 'Sport names can only use letters, numbers and spaces.' };
      if (!chosen.some((sport) => sport.toLowerCase() === name.toLowerCase())) chosen.push(name);
    }
  }

  if (!chosen.length) return { error: 'Select at least one sport.' };
  if (chosen.length > MAX_SPORTS) return { error: `You can select up to ${MAX_SPORTS} sports.` };
  return { sports: chosen };
}

/* Facilities from the tick boxes, as { name, icon, description }. Only known facilities are accepted: the standard list, plus `extra` (an owner's own older facilities). */
function readFacilities(body, extra = []) {
  const ticked = new Set([].concat(body.facilities || []).map(String));
  return [...FACILITIES, ...extra].filter((item) => ticked.has(item.name)).map((item) => ({ ...item, icon: item.icon || '✓' }));
}

/* Ground size: both numbers or neither. Returns { error } or { dimensions }. */
function readDimensions(body) {
  const length = Number(body.length);
  const width = Number(body.width);
  const unit = SIZE_UNITS.some(([key]) => key === body.unit) ? body.unit : 'ft';

  const valid = (n) => Number.isFinite(n) && n > 0 && n <= 1000;
  if (!valid(length) || !valid(width)) return { error: 'Enter the ground length and width (numbers more than 0).' };

  return { dimensions: { length: Math.round(length * 10) / 10, width: Math.round(width * 10) / 10, unit } };
}

/* A point picked on the map. Returns { error } or { location }. */
function readLocation(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (body.lat === '' || body.lng === '' || body.lat === undefined || body.lng === undefined ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { error: 'Please pick your turf location on the map.' };
  }
  return { location: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } };
}

/* Optional social links: a username or a full link. Returns { value } (may be empty) or { error }. */
function readInstagram(value) {
  const text = String(value || '').trim();
  if (text && !/^(https?:\/\/(www\.)?instagram\.com\/\S+|@?[A-Za-z0-9._]{1,30})$/i.test(text)) {
    return { error: 'Instagram must be a username like @royalturf, or an instagram.com link.' };
  }
  return { value: text };
}

function readFacebook(value) {
  const text = String(value || '').trim();
  if (text && !/^(https?:\/\/((www|m|web)\.)?(facebook\.com|fb\.com|fb\.me)\/\S+|@?[A-Za-z0-9.]{5,50})$/i.test(text)) {
    return { error: 'Facebook must be a page name like royalturf, or a facebook.com link.' };
  }
  return { value: text };
}

module.exports = {
  RESERVED_SLUGS,
  SLUG_PATTERN,
  SPORTS,
  SURFACES,
  SIZE_UNITS,
  FACILITIES,
  readSports,
  readFacilities,
  readDimensions,
  readLocation,
  readInstagram,
  readFacebook,
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
  normalizePhone,
  isValidEmail,
  groupConsecutive,
  parseImages,
  parseServices
};