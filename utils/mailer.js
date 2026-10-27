const crypto = require('crypto');

const CODE_MINUTES = 15;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

let transport; // undefined = not set up yet, false = no email service

/*
 * Email is sent with nodemailer. Set these in your .env file:
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_SECURE=true
 *   SMTP_USER=youraddress@gmail.com
 *   SMTP_PASS=your-16-letter-app-password
 *   MAIL_FROM="SquareTurf <youraddress@gmail.com>"
 *
 * Without SMTP_HOST the email is only printed in the server console.
 */
function getTransport() {
  if (transport !== undefined) return transport;

  transport = false;

  if (!process.env.SMTP_HOST) {
    console.warn('[mail] SMTP_HOST is not set in .env, so emails are only printed here and NOT sent.');
    return transport;
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (error) {
    console.warn('[mail] nodemailer is not installed. Run: npm install nodemailer');
    return transport;
  }

  const port = Number(process.env.SMTP_PORT || 587);
  /* Port 465 always uses SSL; other ports use STARTTLS unless SMTP_SECURE says otherwise */
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;

  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, '') }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  /* Check the settings once at start-up so a wrong password shows up in the console straight away */
  transport.verify()
    .then(() => console.log(`[mail] Ready: sending through ${process.env.SMTP_HOST}:${port} as ${process.env.SMTP_USER || 'no login'}`))
    .catch((error) => console.error(`[mail] Cannot log in to the email server: ${error.message}`));

  return transport;
}

const mailIsConfigured = () => Boolean(getTransport());

/* Call once when the server starts so the check above runs immediately */
const initMail = () => { getTransport(); };

async function sendMail({ to, subject, text }) {
  const mailer = getTransport();

  if (!mailer) {
    console.log(`\n[email not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return false;
  }

  try {
    const info = await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER || 'SquareTurf <no-reply@squareturf.com>',
      to,
      subject,
      text
    });
    console.log(`[mail] Sent "${subject}" to ${to} (${info.messageId})`);
    return true;
  } catch (error) {
    console.error(`[mail] Could not send "${subject}" to ${to}: ${error.message}`);
    return false;
  }
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/* Makes a new 6-digit code for the user, saves only its hash, and emails the code */
async function startEmailVerification(user) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

  user.emailVerify = {
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000),
    sentAt: new Date(),
    attempts: 0
  };
  await user.save();

  return sendMail({
    to: user.email,
    subject: 'Your SquareTurf verification code',
    text:
      `Hi ${user.name},\n\n` +
      `Your SquareTurf verification code is ${code}.\n` +
      `It expires in ${CODE_MINUTES} minutes.\n\n` +
      `If you did not create an account, you can ignore this email.`
  });
}

/* Checks a code. Returns 'ok', 'wrong', 'expired' or 'locked'. */
function checkVerificationCode(user, input) {
  const saved = user.emailVerify || {};

  if (!saved.codeHash || !saved.expiresAt || saved.expiresAt < new Date()) return 'expired';
  if ((saved.attempts || 0) >= MAX_ATTEMPTS) return 'locked';

  const given = Buffer.from(hashCode(String(input || '').trim()));
  const wanted = Buffer.from(saved.codeHash);

  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted) ? 'ok' : 'wrong';
}

/* Seconds until a new code may be requested (0 = now) */
function resendWaitSeconds(user) {
  const sentAt = user.emailVerify && user.emailVerify.sentAt;
  if (!sentAt) return 0;

  return Math.max(0, Math.ceil((sentAt.getTime() + RESEND_SECONDS * 1000 - Date.now()) / 1000));
}

module.exports = {
  CODE_MINUTES,
  MAX_ATTEMPTS,
  initMail,
  mailIsConfigured,
  sendMail,
  startEmailVerification,
  checkVerificationCode,
  resendWaitSeconds
};