const { toMinutes } = require('./helpers');

const ACTIVE_STATUSES = ['pending', 'confirmed'];
const RANGE_DAYS = { 7: 7, 30: 30, 90: 90, all: null };
const DEFAULT_RANGE = '30';
const TREND_MAX_DAYS = 30;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (number) => String(number).padStart(2, '0');

/* ---------- Date helpers (dates are "YYYY-MM-DD" strings) ---------- */

const parseDate = (value) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

const formatDate = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const addDays = (value, days) => {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return formatDate(date);
};

const daysBetween = (from, to) => Math.round((parseDate(to) - parseDate(from)) / 86400000);

/* ---------- Booking helpers ---------- */

const isCounted = (booking) => booking.status !== 'cancelled';
const hoursOf = (booking) => Math.max(0, (toMinutes(booking.endTime) - toMinutes(booking.startTime)) / 60);
const isPaid = (booking) => booking.paymentStatus === 'paid';
const paidTime = (booking) => new Date(booking.paidAt || booking.createdAt || 0).getTime();
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const round1 = (value) => Math.round(value * 10) / 10;

/* The same person is identified by the last 10 digits of their phone number */
const customerKey = (booking) =>
  String(booking.customerPhone || '').replace(/\D/g, '').slice(-10) || booking.customerName;

/* Back-to-back hours for one customer become a single session (6-7 + 7-8 = 6-8) */
function mergeSessions(bookings) {
  const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const sessions = [];

  for (const booking of sorted) {
    const last = sessions[sessions.length - 1];
    const continues =
      last &&
      last.customerKey === customerKey(booking) &&
      last.status === booking.status &&
      last.endTime === booking.startTime;

    if (continues) {
      last.endTime = booking.endTime;
      last.hours += hoursOf(booking);
      last.amount += booking.amount;
      last.paid = last.paid && isPaid(booking);
    } else {
      sessions.push({
        customerKey: customerKey(booking),
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        status: booking.status,
        startTime: booking.startTime,
        endTime: booking.endTime,
        hours: hoursOf(booking),
        amount: booking.amount,
        paid: isPaid(booking)
      });
    }
  }
  return sessions;
}

/* ---------- Report sections ---------- */

function summarizeCustomers(counted) {
  const customers = new Map();

  for (const booking of counted) {
    const key = customerKey(booking);
    const entry = customers.get(key) || {
      name: booking.customerName,
      phone: booking.customerPhone,
      visitDates: new Set(),
      hours: 0,
      paid: 0,
      lastDate: ''
    };

    entry.visitDates.add(booking.date);
    entry.hours += hoursOf(booking);
    entry.paid += isPaid(booking) ? booking.amount : 0;
    if (booking.date > entry.lastDate) entry.lastDate = booking.date;
    customers.set(key, entry);
  }

  const list = [...customers.values()].map((entry) => ({
    name: entry.name,
    phone: entry.phone,
    visits: entry.visitDates.size,
    hours: round1(entry.hours),
    paid: entry.paid,
    lastDate: entry.lastDate
  }));

  return {
    unique: list.length,
    repeat: list.filter((customer) => customer.visits > 1).length,
    top: list.sort((a, b) => b.hours - a.hours || b.paid - a.paid).slice(0, 5)
  };
}

function buildTrend(counted, today, dayCount) {
  const counts = new Map();
  for (const booking of counted) counts.set(booking.date, (counts.get(booking.date) || 0) + 1);

  return Array.from({ length: dayCount }, (_, index) => {
    const date = addDays(today, index - (dayCount - 1));
    return { date, count: counts.get(date) || 0 };
  });
}

function buildBusiestHours(counted) {
  const counts = new Map();
  for (const booking of counted) counts.set(booking.startTime, (counts.get(booking.startTime) || 0) + 1);

  return [...counts.entries()]
    .map(([startTime, count]) => ({ startTime, count }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function buildWeekdays(counted) {
  const counts = new Array(7).fill(0);
  for (const booking of counted) counts[parseDate(booking.date).getDay()] += 1;
  return WEEKDAYS.map((label, index) => ({ label, count: counts[index] }));
}

function buildPayments(allBookings) {
  const paid = allBookings.filter(isPaid).sort((a, b) => paidTime(a) - paidTime(b));

  return {
    count: paid.length,
    total: sum(paid, (booking) => booking.amount),
    first: paid[0] || null,
    recent: paid.slice(-5).reverse()
  };
}

/* Today's bookings in time order, each marked done, now or next */
function buildToday(allBookings, today, nowTime) {
  const todays = allBookings.filter(
    (booking) => booking.date === today && booking.status !== 'cancelled'
  );

  return mergeSessions(todays).map((session) => ({
    ...session,
    state:
      session.endTime <= nowTime ? 'done' : session.startTime <= nowTime ? 'now' : 'next'
  }));
}

/* ---------- Main report ---------- */

/*
 * Turns every booking of a turf into the numbers shown on the dashboard.
 * Options: range ('7' | '30' | '90' | 'all'), today ("YYYY-MM-DD"),
 * nowTime ("HH:MM") and the turf's opening and closing times.
 */
function buildAnalytics(allBookings, { range, today, nowTime, openingTime, closingTime }) {
  const selectedRange = Object.hasOwn(RANGE_DAYS, range) ? String(range) : DEFAULT_RANGE;
  const rangeDays = RANGE_DAYS[selectedRange];
  const startDate = rangeDays ? addDays(today, -(rangeDays - 1)) : null;

  /* Play dates up to today inside the chosen period */
  const inRange = allBookings.filter(
    (booking) => booking.date <= today && (!startDate || booking.date >= startDate)
  );
  const counted = inRange.filter(isCounted);
  const cancelled = inRange.length - counted.length;

  /* Length of the period, used for averages and occupancy */
  const firstDate = counted.reduce((min, b) => (!min || b.date < min ? b.date : min), '');
  const spanDays = rangeDays || (firstDate ? daysBetween(firstDate, today) + 1 : 1);

  const hoursPlayed = sum(counted, hoursOf);
  const openHoursPerDay = Math.max(0, (toMinutes(closingTime) - toMinutes(openingTime)) / 60);
  const availableHours = openHoursPerDay * spanDays;

  const settled = counted.filter((booking) => ['confirmed', 'completed'].includes(booking.status));

  const statusCounts = { pending: 0, confirmed: 0, completed: 0, cancelled };
  for (const booking of counted) statusCounts[booking.status] += 1;

  return {
    range: selectedRange,
    ranges: Object.keys(RANGE_DAYS),
    periodLabel: rangeDays ? `Last ${rangeDays} days` : 'All time',

    totals: {
      bookings: counted.length,
      hoursPlayed: round1(hoursPlayed),
      averagePerDay: round1(counted.length / spanDays),
      cancelRate: inRange.length ? Math.round((cancelled / inRange.length) * 100) : 0,
      occupancy: availableHours ? Math.min(100, Math.round((hoursPlayed / availableHours) * 100)) : 0,
      collected: sum(counted.filter(isPaid), (booking) => booking.amount),
      toCollect: sum(settled.filter((booking) => !isPaid(booking)), (booking) => booking.amount)
    },

    statusCounts,
    customers: summarizeCustomers(counted),
    trend: buildTrend(counted, today, Math.min(rangeDays || TREND_MAX_DAYS, TREND_MAX_DAYS)),
    busiestHours: buildBusiestHours(counted),
    weekdays: buildWeekdays(counted),
    payments: buildPayments(allBookings),

    /* Not tied to the period: what needs attention now */
    pendingRequests: allBookings.filter((booking) => booking.status === 'pending').length,
    upcoming: allBookings.filter(
      (booking) =>
        ACTIVE_STATUSES.includes(booking.status) &&
        (booking.date > today || (booking.date === today && booking.endTime > nowTime))
    ).length,
    today: buildToday(allBookings, today, nowTime)
  };
}

module.exports = { buildAnalytics };