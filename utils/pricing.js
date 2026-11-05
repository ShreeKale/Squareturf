/*
 * Pricing and opening hours.
 *
 * A turf has one base price per hour (pricePerHour). With "custom" pricing it also has rules such as
 *   Monday to Friday, 12 AM to 6 AM: 1200
 * A slot uses the first rule that covers its day and start time, and the base price when no rule does.
 */
const { DAYS, ALL_DAYS, JS_DAY_KEYS } = require('./onboarding');
const { toMinutes } = require('./helpers');

const MAX_RULES = 12;
const MAX_PRICE = 1000000;
const DAY_LABELS = Object.fromEntries(DAYS);

const dayKeyOf = (dateString) => {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return JS_DAY_KEYS[new Date(year, month - 1, day).getDay()];
};

const hasCustomPricing = (tenant) =>
  Boolean(tenant) && tenant.pricingMode === 'custom' && Array.isArray(tenant.pricingRules) && tenant.pricingRules.length > 0;

/* Price of the hourly slot that starts at startTime on dateString ("YYYY-MM-DD") */
function priceForSlot(tenant, dateString, startTime) {
  const base = Number(tenant && tenant.pricePerHour) || 0;
  if (!hasCustomPricing(tenant)) return base;

  const day = dayKeyOf(dateString);
  const start = toMinutes(startTime);

  const rule = tenant.pricingRules.find(
    (item) => item.days.includes(day) && start >= toMinutes(item.startTime) && start < toMinutes(item.endTime)
  );
  return rule ? Number(rule.price) : base;
}

/* Every price a customer can be charged, with the hours they apply to, for "Starts from" and the price list */
function priceSummary(tenant) {
  const base = Number(tenant && tenant.pricePerHour) || 0;
  if (!hasCustomPricing(tenant)) return { custom: false, lowest: base, rows: [], baseApplies: true };

  const open = Array.isArray(tenant.operatingDays) && tenant.operatingDays.length ? tenant.operatingDays : ALL_DAYS;
  const start = toMinutes(tenant.openingTime);
  const end = toMinutes(tenant.closingTime);

  let lowest = Infinity;
  let baseApplies = false;

  for (const day of open) {
    for (let minutes = start; minutes + 60 <= end; minutes += 60) {
      const rule = tenant.pricingRules.find(
        (item) => item.days.includes(day) && minutes >= toMinutes(item.startTime) && minutes < toMinutes(item.endTime)
      );
      const price = rule ? Number(rule.price) : base;
      if (!rule) baseApplies = true;
      lowest = Math.min(lowest, price);
    }
  }

  return {
    custom: true,
    lowest: Number.isFinite(lowest) ? lowest : base,
    baseApplies,
    rows: tenant.pricingRules.map((rule) => ({
      days: daysLabel(rule.days),
      startTime: rule.startTime,
      endTime: rule.endTime,
      price: Number(rule.price)
    }))
  };
}

/* ["mon","tue","wed","thu","fri"] => "Mon to Fri", ["sat","sun"] => "Sat and Sun" */
function daysLabel(days) {
  const set = ALL_DAYS.filter((day) => days.includes(day));
  if (set.length === 7) return 'Every day';

  const short = (day) => DAY_LABELS[day].slice(0, 3);
  const first = ALL_DAYS.indexOf(set[0]);
  const consecutive = set.length > 2 && set.every((day, i) => ALL_DAYS.indexOf(day) === first + i);

  if (consecutive) return `${short(set[0])} to ${short(set[set.length - 1])}`;
  if (set.length === 2) return `${short(set[0])} and ${short(set[1])}`;
  return set.map(short).join(', ');
}

/* "06:00" or "24:00" => "6 AM" or "12 AM" */
function hourLabel(time) {
  const hour = Math.floor(toMinutes(time) / 60) % 24;
  return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/* ---------- Reading and checking form data ---------- */

const hourValue = (value) => {
  const match = /^(\d{1,2}):00$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
};

/*
 * Opening hours from a form. "Open 24 hours" is saved as 00:00 to 24:00.
 * Returns { error } or { open24Hours, openingTime, closingTime }.
 */
function readHours(body, isValidTime) {
  if (body.open24Hours === '1' || body.open24Hours === 'on' || body.open24Hours === true) {
    return { open24Hours: true, openingTime: '00:00', closingTime: '24:00' };
  }

  const openingTime = String(body.openingTime || '');
  const closingTime = String(body.closingTime || '');

  if (!isValidTime(openingTime) || !isValidTime(closingTime)) {
    return { error: 'Please enter valid opening and closing times.' };
  }
  if (closingTime <= openingTime) return { error: 'Closing time must be later than opening time.' };

  return { open24Hours: false, openingTime, closingTime };
}

/*
 * Price settings from a form: pricingMode ("flat" or "custom"), pricePerHour and pricingRules (JSON text).
 * Returns { error } or { pricingMode, pricePerHour, pricingRules }.
 */
function readPricing(body, { allowZero = false } = {}) {
  const mode = body.pricingMode === 'custom' ? 'custom' : 'flat';

  const pricePerHour = Number(body.pricePerHour);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isFinite(pricePerHour) || pricePerHour < minimum || pricePerHour > MAX_PRICE) {
    return {
      error: mode === 'custom'
        ? 'Enter the price for hours not covered by a pricing rule.'
        : 'Please enter your price per hour (more than 0).'
    };
  }

  if (mode === 'flat') return { pricingMode: 'flat', pricePerHour, pricingRules: [] };

  let raw;
  try {
    raw = JSON.parse(String(body.pricingRules || '[]'));
  } catch {
    return { error: 'The pricing rules could not be read. Please check them and try again.' };
  }
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one pricing rule, or choose one price for all days and times.' };
  if (raw.length > MAX_RULES) return { error: `You can add up to ${MAX_RULES} pricing rules.` };

  const rules = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] || {};
    const label = `Pricing rule ${i + 1}`;

    const days = ALL_DAYS.filter((day) => [].concat(item.days || []).includes(day));
    if (!days.length) return { error: `${label}: select at least one day.` };

    const from = hourValue(item.startTime);
    const to = hourValue(item.endTime);
    if (from === null || to === null || from > 23 || to < 1 || to > 24) return { error: `${label}: choose a start and end time.` };
    if (to <= from) return { error: `${label}: the end time must be later than the start time.` };

    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) return { error: `${label}: enter the price per hour.` };

    rules.push({
      days,
      startTime: `${String(from).padStart(2, '0')}:00`,
      endTime: `${String(to).padStart(2, '0')}:00`,
      price: Math.round(price)
    });
  }

  /* Two rules must not cover the same hour on the same day */
  for (let a = 0; a < rules.length; a += 1) {
    for (let b = a + 1; b < rules.length; b += 1) {
      const shared = rules[a].days.filter((day) => rules[b].days.includes(day));
      const clash = rules[a].startTime < rules[b].endTime && rules[b].startTime < rules[a].endTime;
      if (shared.length && clash) {
        return { error: `Pricing rules ${a + 1} and ${b + 1} overlap on ${daysLabel(shared)}. Change the days or the times.` };
      }
    }
  }

  return { pricingMode: 'custom', pricePerHour, pricingRules: rules };
}

module.exports = { MAX_RULES, daysLabel, hourLabel, priceForSlot, priceSummary, readHours, readPricing, hasCustomPricing };