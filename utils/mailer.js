const crypto = require('crypto');

const CODE_MINUTES = 15;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

let transport; // undefined = not set up yet, false = no email service

/*
 * Email is sent with nodemailer when SMTP_HOST is set (see .env). Without it, the email is
 * printed in the server console so sign-up still works while you develop.
 */
function getTransport() {
  if (transport !== undefined) return transport;

  transport = false;
  if (!process.env.SMTP_HOST) return transport;

  try {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  } catch (error) {
    console.warn('SMTP_HOST is set but nodemailer is not installed. Run: npm install nodemailer');
  }
  return transport;
}

const mailIsConfigured = () => Boolean(getTransport());

async function sendMail({ to, subject, text }) {
  const mailer = getTransport();

  if (!mailer) {
    console.log(`\n[email not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return false;
  }

  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || 'SquareTurf <no-reply@squareturf.com>',
      to,
      subject,
      text
    });
    return true;
  } catch (error) {
    console.error('Could not send email:', error.message);
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

  await sendMail({
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
  mailIsConfigured,
  sendMail,
  startEmailVerification,
  checkVerificationCode,
  resendWaitSeconds
};