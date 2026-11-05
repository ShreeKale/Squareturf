const crypto = require('crypto');
const { sendMail } = require('./mailer');
const { groupConsecutive, isValidEmail } = require('./helpers');

/* =========================================================
   Booking emails
   - owner:    "New booking request" with Confirm / Paid / Cancel / Unpaid buttons
   - customer: "We received your request", then "Booking confirmed"
   The buttons are links to /booking-action/... signed with a secret, so they work without logging in.
========================================================= */

const SECRET = () => process.env.SESSION_SECRET || 'squareturf-development-secret';

const ACTIONS = {
  confirm: { label: 'Confirm', color: '#16a34a' },
  paid:    { label: 'Mark paid', color: '#2563eb' },
  cancel:  { label: 'Cancel', color: '#dc2626' },
  unpaid:  { label: 'Mark unpaid', color: '#6b7280' }
};

const newRequestId = () => crypto.randomBytes(12).toString('hex');

const tokenFor = (requestId) =>
  crypto.createHmac('sha256', SECRET()).update(`booking-action:${requestId}`).digest('hex').slice(0, 32);

function tokenIsValid(requestId, token) {
  const given = Buffer.from(String(token || ''));
  const wanted = Buffer.from(tokenFor(requestId));
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

const actionUrl = (origin, requestId, action) =>
  `${origin}/booking-action/${requestId}/${action}?t=${tokenFor(requestId)}`;

/* ---------- Formatting ---------- */

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rupees = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

function timeText(time) {
  const [h, m] = String(time).split(':').map(Number);
  const hour = h % 24;
  return `${hour % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

function dateText(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}

/* Slots next to each other become one line: "6 PM – 8 PM" */
function summarize(bookings) {
  const groups = groupConsecutive(bookings.map((b) => ({
    date: b.date, startTime: b.startTime, endTime: b.endTime, amount: Number(b.amount) || 0,
    status: 'x', paymentStatus: 'x'
  })));
  return {
    lines: groups.map((g) => `${dateText(g.date)}, ${timeText(g.startTime)} – ${timeText(g.endTime)}`),
    total: bookings.reduce((sum, b) => sum + (Number(b.amount) || 0), 0),
    hours: bookings.length
  };
}

const statusText = (bookings) => {
  const active = bookings.filter((b) => b.status !== 'cancelled');
  if (!active.length) return 'Cancelled';
  return active.every((b) => b.status === 'confirmed' || b.status === 'completed') ? 'Confirmed' : 'Waiting for confirmation';
};
const paymentText = (bookings) => (bookings.every((b) => b.paymentStatus === 'paid') ? 'Paid' : 'Not paid yet');

/* ---------- HTML pieces (inline styles: email programs ignore stylesheets) ---------- */

const row = (label, value) =>
  `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;width:130px;vertical-align:top">${esc(label)}</td>` +
  `<td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${value}</td></tr>`;

const button = (href, label, color) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:4px 6px 4px 0;padding:11px 18px;border-radius:8px;background:${color};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${esc(label)}</a>`;

function layout({ preheader, title, intro, rows, extra = '', footer }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:26px">
<tr><td>
<h1 style="margin:0 0 8px;font-size:20px;color:#111827">${esc(title)}</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#374151">${intro}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin-bottom:16px">${rows}</table>
${extra}
<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#9ca3af">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}

const slotRows = (info) =>
  row('Slots', info.lines.map(esc).join('<br>')) +
  row('Duration', `${info.hours} ${info.hours === 1 ? 'hour' : 'hours'}`) +
  row('Total', esc(rupees(info.total)));

/* ---------- Emails ---------- */

/* Owner: a new request came in */
function ownerRequestMail({ tenant, bookings, requestId, origin }) {
  const first = bookings[0];
  const info = summarize(bookings);
  const buttons = Object.entries(ACTIONS).map(([key, a]) => button(actionUrl(origin, requestId, key), a.label, a.color)).join('');

  const rows =
    row('Turf', esc(tenant.name)) +
    row('Customer', esc(first.customerName)) +
    row('Phone', `<a href="tel:${esc(first.customerPhone)}" style="color:#2563eb;text-decoration:none">${esc(first.customerPhone)}</a>`) +
    (first.customerEmail ? row('Email', esc(first.customerEmail)) : '') +
    slotRows(info) +
    row('Status', 'Waiting for confirmation') +
    row('Payment', 'Not paid yet');

  const text =
    `New booking request for ${tenant.name}\n\n` +
    `Customer: ${first.customerName}\nPhone: ${first.customerPhone}\n` +
    (first.customerEmail ? `Email: ${first.customerEmail}\n` : '') +
    `Slots:\n  ${info.lines.join('\n  ')}\nDuration: ${info.hours} hour(s)\nTotal: ${rupees(info.total)}\n\n` +
    Object.entries(ACTIONS).map(([key, a]) => `${a.label}: ${actionUrl(origin, requestId, key)}`).join('\n');

  return {
    subject: `New booking request: ${info.lines[0]}${info.lines.length > 1 ? ' +more' : ''} (${rupees(info.total)})`,
    text,
    html: layout({
      preheader: `${first.customerName} requested ${info.lines[0]}`,
      title: 'New booking request',
      intro: `<strong>${esc(first.customerName)}</strong> has requested a slot at <strong>${esc(tenant.name)}</strong>. Tap a button below to update the booking. Confirm, Mark paid and Mark unpaid apply straight away; Cancel asks you once more.`,
      rows,
      extra: `<div>${buttons}</div>`,
      footer: 'These buttons are private to you. Do not forward this email. You can also manage the booking from your SquareTurf dashboard.'
    })
  };
}

/* Customer: we received your request */
function customerRequestMail({ tenant, bookings }) {
  const info = summarize(bookings);
  const rows =
    row('Turf', esc(tenant.name)) +
    slotRows(info) +
    row('Status', 'Waiting for confirmation') +
    (tenant.address ? row('Address', esc(tenant.address)) : '') +
    (tenant.phone ? row('Turf phone', esc(tenant.phone)) : '');

  return {
    subject: `Booking request received: ${tenant.name}`,
    text:
      `Hi ${bookings[0].customerName},\n\nWe received your booking request at ${tenant.name}.\n\n` +
      `Slots:\n  ${info.lines.join('\n  ')}\nTotal: ${rupees(info.total)}\n\n` +
      `It is not confirmed yet. The turf owner will confirm it and you will get another email.` +
      (tenant.phone ? `\nTurf phone: ${tenant.phone}` : ''),
    html: layout({
      preheader: 'Your request has been sent to the turf owner',
      title: 'Booking request received',
      intro: `Hi ${esc(bookings[0].customerName)}, thanks for your request. It is <strong>not confirmed yet</strong>: the turf owner will check it and you will get another email once it is confirmed.`,
      rows,
      footer: `Sent by ${esc(tenant.name)} through SquareTurf.`
    })
  };
}

/* Customer: the owner confirmed */
function customerConfirmedMail({ tenant, bookings }) {
  const active = bookings.filter((b) => b.status === 'confirmed' || b.status === 'completed');
  const info = summarize(active.length ? active : bookings);
  const rows =
    row('Turf', esc(tenant.name)) +
    slotRows(info) +
    row('Status', 'Confirmed') +
    row('Payment', esc(paymentText(active.length ? active : bookings))) +
    (tenant.address ? row('Address', esc(tenant.address)) : '') +
    (tenant.phone ? row('Turf phone', esc(tenant.phone)) : '');

  return {
    subject: `Booking confirmed: ${tenant.name}`,
    text:
      `Hi ${bookings[0].customerName},\n\nYour booking at ${tenant.name} is confirmed.\n\n` +
      `Slots:\n  ${info.lines.join('\n  ')}\nTotal: ${rupees(info.total)}\nPayment: ${paymentText(active.length ? active : bookings)}\n` +
      (tenant.address ? `Address: ${tenant.address}\n` : '') +
      (tenant.phone ? `Turf phone: ${tenant.phone}\n` : '') + '\nSee you on the turf!',
    html: layout({
      preheader: 'Your booking is confirmed',
      title: 'Your booking is confirmed',
      intro: `Hi ${esc(bookings[0].customerName)}, good news: <strong>${esc(tenant.name)}</strong> has confirmed your booking. See you on the turf!`,
      rows,
      footer: `Sent by ${esc(tenant.name)} through SquareTurf. To change or cancel, please call the turf.`
    })
  };
}

const validEmail = (email) => Boolean(email) && isValidEmail(String(email));

/* Each send is awaited by the caller (on Vercel the function stops once the response is sent) and never throws */
async function safeSend(mail, to) {
  if (!to) return false;
  try { return await sendMail({ to, ...mail }); } catch (error) { console.error('[mail] booking email failed:', error.message); return false; }
}

async function sendRequestEmails({ tenant, ownerEmails, bookings, requestId, origin }) {
  const jobs = [];
  const owners = [...new Set((ownerEmails || []).filter(validEmail))];
  if (owners.length) jobs.push(safeSend(ownerRequestMail({ tenant, bookings, requestId, origin }), owners.join(', ')));
  if (validEmail(bookings[0].customerEmail)) jobs.push(safeSend(customerRequestMail({ tenant, bookings }), bookings[0].customerEmail));
  await Promise.all(jobs);
}

async function sendConfirmedEmail({ tenant, bookings }) {
  if (!bookings.length || !validEmail(bookings[0].customerEmail)) return false;
  return safeSend(customerConfirmedMail({ tenant, bookings }), bookings[0].customerEmail);
}

module.exports = {
  ACTIONS, newRequestId, tokenIsValid, tokenFor,
  summarize, statusText, paymentText, dateText, timeText,
  sendRequestEmails, sendConfirmedEmail
};