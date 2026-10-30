require('dotenv').config();
 
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const morgan = require('morgan');
const path = require('path');
const bcrypt = require('bcryptjs');
 
const User = require('./models/User');
const Tenant = require('./models/Tenant');
const Booking = require('./models/Booking');
const Plan = require('./models/Plan');
const Customer = require('./models/Customer');
const Review = require('./models/Review');
 
const { requireAuth, requireOwner, requireAdmin } = require('./middleware/auth');
const tenantResolver = require('./middleware/tenant');
 
const {
  MAX_SLOTS_PER_REQUEST,
  asyncHandler,
  getLocalDateString,
  getLocalTimeString,
  isValidDateString,
  isValidTime,
  makeHourlySlots,
  overlaps,
  slotKey,
  normalizeSlots,
  normalizePhone,
  isValidEmail,
  groupConsecutive,
  parseImages,
  parseServices
} = require('./utils/helpers');
 
const { buildAnalytics } = require('./utils/analytics');
const { createRateLimiter } = require('./utils/rateLimit');
const { isOperatingDay, nextStepPath } = require('./utils/onboarding');
const { themeFor } = require('./utils/themes');
const { ALLOWED_ICON_SIZES, SERVICE_WORKER, buildIcon, buildManifest } = require('./utils/pwa');
const { startEmailVerification, initMail } = require('./utils/mailer');
const { connectDb } = require('./utils/db');
const onboardingRouter = require('./routes/onboarding');
 
const app = express();
 
const PORT = process.env.PORT || 5000;
const BASE_DOMAIN = String(process.env.BASE_DOMAIN || 'localhost').toLowerCase();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
/* On Vercel the app is never "local", even if BASE_DOMAIN was not set */
const IS_LOCAL = BASE_DOMAIN === 'localhost' && !process.env.VERCEL;
 
/* Turf websites on their own subdomain (royalturf.yourdomain.com) need your own domain with a wildcard DNS record.
   On a plain *.vercel.app address they cannot work, so turf pages are linked as /turf/royalturf instead. */
const USE_SUBDOMAINS = !IS_LOCAL && BASE_DOMAIN.includes('.') && !BASE_DOMAIN.endsWith('.vercel.app');
 
const ACTIVE_BOOKING_STATUSES = ['pending', 'confirmed'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'cancelled', 'suspended'];
 
/* Pages an action button may send the owner back to */
const RETURN_PATHS = new Set(['/dashboard', '/dashboard/bookings']);
const getReturnPath = (value) => (RETURN_PATHS.has(value) ? value : '/dashboard/bookings');
 
/* =========================================================
   APP CONFIG
========================================================= */
 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
 
/* Vercel sits in front of the app: trust it for the real IP, host name and https */
app.set('trust proxy', 1);
 
if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Add a long random value in your environment variables.');
}
 
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));
 
/* Connects to MongoDB once, and adds the plans and the admin account once, for each server instance */
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = connectDb()
      .then(async () => {
        await seedPlans();
        await createAdmin();
        initMail();
      })
      .catch((error) => {
        ready = null; // try again on the next request
        throw error;
      });
  }
  return ready;
}
 
/* Open this address to check the database: /healthz */
app.get('/healthz', async (req, res) => {
  try {
    await ensureReady();
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'not connected', fix: error.hint || 'See the server log.' });
  }
});
 
/* Everything below needs the database. If it is down, show a clear page instead of hanging. */
app.use((req, res, next) => {
  ensureReady().then(
    () => next(),
    (error) => {
      console.error('Database not available:', error.message);
      res.status(503).render('error', {
        title: 'Service unavailable',
        message: 'We cannot reach the database right now. Please try again in a moment.'
      });
    }
  );
});
 
/* The session store is created after the database is connected, and shares its connection */
let sessionMiddleware = null;
app.use((req, res, next) => {
  if (!sessionMiddleware) {
    sessionMiddleware = session({
      secret: process.env.SESSION_SECRET || 'squareturf-development-secret',
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({ client: mongoose.connection.getClient() }),
      cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION
      }
    });
  }
  sessionMiddleware(req, res, next);
});
 
/* Values every view can use */
app.use((req, res, next) => {
  res.locals.currentUser = null; // replaced by requireAuth on logged-in pages
  res.locals.isLoggedIn = Boolean(req.session.userId);
  res.locals.baseDomain = BASE_DOMAIN;
  res.locals.port = PORT;
 
  /* Public address of a turf website, for links and for showing to the owner */
  const origin = `${req.protocol}://${req.get('host')}`;
  res.locals.siteUrlFor = (slug) =>
    USE_SUBDOMAINS ? `https://${slug}.${BASE_DOMAIN}`
    : IS_LOCAL ? `http://${slug}.localhost:${PORT}`
    : `${origin}/turf/${slug}`;
  res.locals.siteLabelFor = (slug) =>
    USE_SUBDOMAINS ? `${slug}.${BASE_DOMAIN}`
    : IS_LOCAL ? `${slug}.localhost`
    : `${req.get('host')}/turf/${slug}`;
  res.locals.useSubdomains = USE_SUBDOMAINS || IS_LOCAL;
 
  /* One-time message set with req.session.flash */
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
 
  next();
});
 
app.use(tenantResolver);
 
/* Sign-up steps 2 to 6 (step 1 is /register) */
app.use('/onboarding', onboardingRouter);
 
/* =========================================================
   HELPERS
========================================================= */
 
const renderError = (res, status, title, message) =>
  res.status(status).render('error', { title, message });
 
const getPublicTenant = (slug) =>
  slug
    ? Tenant.findOne({ slug: String(slug).toLowerCase(), isPublished: true }).lean()
    : null;
 
/* ---------- Customer session (one logged-in customer per turf website) ---------- */
 
const customerLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
 
const toCustomerView = ({ name, phone, email }) => ({ name, phone, email });
 
async function getSessionCustomer(req, tenant) {
  const id = (req.session.customers || {})[String(tenant._id)];
 
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return Customer.findOne({ _id: id, tenant: tenant._id }).lean();
}
 
function setSessionCustomer(req, tenant, customer) {
  req.session.customers = { ...req.session.customers, [String(tenant._id)]: String(customer._id) };
}
 
function clearSessionCustomer(req, tenant) {
  const customers = { ...req.session.customers };
  delete customers[String(tenant._id)];
  req.session.customers = customers;
}
 
async function renderTurfPage(req, res, tenant) {
  const customer = await getSessionCustomer(req, tenant);
 
  res.render('public-turf', {
    title: tenant.name,
    tenant,
    customer: customer ? toCustomerView(customer) : null,
    theme: themeFor(tenant.theme),
    pwaBase: pwaBaseFor(req, tenant)
  });
}
 
/* Where the install files of a turf live: the site root on its own subdomain, otherwise under /turf/<slug> */
const pwaBaseFor = (req, tenant) => (req.publicTenant ? '' : `/turf/${tenant.slug}`);
 
/* Finds the published turf for /api/public/:slug/... routes and puts it on req.turf */
const loadPublicTurf = asyncHandler(async (req, res, next) => {
  const tenant = await getPublicTenant(req.params.slug);
 
  if (!tenant) return res.status(404).json({ message: 'Turf not found.' });
 
  req.turf = tenant;
  next();
});
 
/* Hourly slots for a date, each marked available or booked */
async function getAvailability(tenant, date) {
  if (!isOperatingDay(tenant, date)) return []; // closed that day
 
  const bookings = await Booking.find({
    tenant: tenant._id,
    date,
    status: { $in: ACTIVE_BOOKING_STATUSES }
  })
    .select('startTime endTime')
    .lean();
 
  return makeHourlySlots(tenant.openingTime, tenant.closingTime).map((slot) => ({
    ...slot,
    available: !bookings.some((booking) => overlaps(booking, slot))
  }));
}
 
/* =========================================================
   PUBLIC PAGES
========================================================= */
 
app.get(
  '/',
  asyncHandler(async (req, res) => {
    if (req.publicTenant) return renderTurfPage(req, res, req.publicTenant);
 
    res.render('home', { title: 'SquareTurf' });
  })
);
 
app.get(
  '/turf/:slug',
  asyncHandler(async (req, res) => {
    const tenant = await getPublicTenant(req.params.slug);
 
    if (!tenant) {
      return renderError(res, 404, 'Turf not found', 'This turf website is unavailable.');
    }
 
    await renderTurfPage(req, res, tenant);
  })
);
 
/* ---------- Install as an app (manifest, service worker, icon) ----------
   Served both on a turf's own subdomain (/manifest.webmanifest) and under /turf/<slug>/ */
 
const pwaTurf = async (req) => req.publicTenant || getPublicTenant(req.params.slug);
 
const pwaRoute = (file, handler) =>
  app.get(
    [`/${file}`, `/turf/:slug/${file}`],
    asyncHandler(async (req, res) => {
      const tenant = await pwaTurf(req);
      if (!tenant) return res.status(404).end();
 
      res.set('Cache-Control', 'public, max-age=0, must-revalidate');
      handler(req, res, tenant, pwaBaseFor(req, tenant), themeFor(tenant.theme).colors[600]);
    })
  );
 
pwaRoute('manifest.webmanifest', (req, res, tenant, base, color) => {
  res.type('application/manifest+json').send(JSON.stringify(buildManifest(tenant, color, base)));
});
 
pwaRoute('sw.js', (req, res) => {
  res.type('application/javascript').send(SERVICE_WORKER);
});
 
pwaRoute('icon-:size.png', (req, res, tenant, base, color) => {
  const size = Number(req.params.size);
  if (!ALLOWED_ICON_SIZES.has(size)) return res.status(404).end();
 
  res.set('Cache-Control', 'public, max-age=86400').type('image/png').send(buildIcon(size, color));
});
 
/* Old booking link: send visitors to the booking section of the turf page */
app.get('/book/:slug', (req, res) => {
  res.redirect(`/turf/${encodeURIComponent(req.params.slug)}#booking`);
});
 
app.get(
  '/pricing',
  asyncHandler(async (req, res) => {
    const plans = await Plan.find({ active: true }).sort({ price: 1 }).lean();
    res.render('pricing', { title: 'Pricing', plans });
  })
);
 
/* =========================================================
   PUBLIC BOOKING API
========================================================= */
 
app.get(
  '/api/public/:slug/availability',
  asyncHandler(async (req, res) => {
    const tenant = await getPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ message: 'Turf not found.' });
 
    const date = String(req.query.date || '');
 
    if (!isValidDateString(date)) {
      return res.status(400).json({ message: 'Please select a valid date.' });
    }
    if (date < getLocalDateString()) {
      return res.status(400).json({ message: 'Past dates cannot be booked.' });
    }
 
    res.json({ date, slots: await getAvailability(tenant, date) });
  })
);
 
/* Each selected hour is saved as its own pending booking */
app.post(
  '/public-booking/:slug',
  asyncHandler(async (req, res) => {
    const tenant = await getPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ message: 'Turf not found.' });
 
    const { date, slots } = req.body;
 
    /* A logged-in customer's saved details are used, so nothing is asked again */
    const customer = await getSessionCustomer(req, tenant);
    const contact = customer
      ? {
          customer: customer._id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email
        }
      : {
          customer: null,
          customerName: String(req.body.customerName || '').trim(),
          customerPhone: String(req.body.customerPhone || '').trim(),
          customerEmail: String(req.body.customerEmail || '').trim().toLowerCase()
        };
 
    if (
      !contact.customerName ||
      !contact.customerPhone ||
      !date ||
      !Array.isArray(slots) ||
      !slots.length
    ) {
      return res.status(400).json({
        message: 'Please select at least one slot and complete your details.'
      });
    }
    if (slots.length > MAX_SLOTS_PER_REQUEST) {
      return res.status(400).json({
        message: `You can select a maximum of ${MAX_SLOTS_PER_REQUEST} slots.`
      });
    }
    if (!isValidDateString(date)) {
      return res.status(400).json({ message: 'Please select a valid date.' });
    }
    if (date < getLocalDateString()) {
      return res.status(400).json({ message: 'Past dates cannot be booked.' });
    }
    if (!isOperatingDay(tenant, date)) {
      return res.status(400).json({ message: 'The turf is closed on that day. Please choose another date.' });
    }
 
    const selected = normalizeSlots(slots);
    if (!selected.length) {
      return res.status(400).json({ message: 'Please select valid hourly slots.' });
    }
 
    const validKeys = new Set(
      makeHourlySlots(tenant.openingTime, tenant.closingTime).map(slotKey)
    );
    if (!selected.every((slot) => validKeys.has(slotKey(slot)))) {
      return res.status(400).json({ message: 'One or more selected slots are invalid.' });
    }
 
    const existing = await Booking.find({
      tenant: tenant._id,
      date,
      status: { $in: ACTIVE_BOOKING_STATUSES }
    })
      .select('startTime endTime')
      .lean();
 
    const conflict = selected.find((slot) => existing.some((booking) => overlaps(booking, slot)));
    if (conflict) {
      return res.status(409).json({
        message: `The slot ${conflict.startTime} - ${conflict.endTime} is no longer available. Please select your slots again.`
      });
    }
 
    const hourlyPrice = Number(tenant.pricePerHour || 0);
 
    await Booking.insertMany(
      selected.map((slot) => ({
        tenant: tenant._id,
        ...contact,
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        amount: hourlyPrice,
        paymentStatus: 'unpaid',
        status: 'pending'
      }))
    );
 
    const count = selected.length;
 
    res.json({
      message: `${count} ${count === 1 ? 'slot' : 'slots'} booking request sent. The turf owner will contact you for confirmation.`,
      slots: selected,
      totalSlots: count,
      totalAmount: hourlyPrice * count
    });
  })
);
 
/* =========================================================
   CUSTOMER ACCOUNTS (public turf website)
   Register with name, email and phone. Log in with the phone number only.
========================================================= */
 
app.post(
  '/api/public/:slug/customer/register',
  customerLimiter,
  loadPublicTurf,
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
 
    if (!name || !email || !String(req.body.phone || '').trim()) {
      return res.status(400).json({ message: 'Please enter your name, email and phone number.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }
    if (!phone) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit phone number.' });
    }
 
    const alreadyRegistered = () =>
      res.status(409).json({
        message: 'This number is already registered. Please log in instead.',
        code: 'exists'
      });
 
    if (await Customer.exists({ tenant: req.turf._id, phone })) return alreadyRegistered();
 
    try {
      const customer = await Customer.create({ tenant: req.turf._id, name, email, phone });
 
      setSessionCustomer(req, req.turf, customer);
      res.status(201).json({ customer: toCustomerView(customer) });
    } catch (error) {
      if (error.code === 11000) return alreadyRegistered(); // two sign-ups at the same moment
      throw error;
    }
  })
);
 
app.post(
  '/api/public/:slug/customer/login',
  customerLimiter,
  loadPublicTurf,
  asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
 
    if (!phone) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit phone number.' });
    }
 
    const customer = await Customer.findOne({ tenant: req.turf._id, phone }).lean();
 
    if (!customer) {
      return res.status(404).json({
        message: 'No account found for this number. Please register.',
        code: 'not_found'
      });
    }
 
    setSessionCustomer(req, req.turf, customer);
    res.json({ customer: toCustomerView(customer) });
  })
);
 
app.post(
  '/api/public/:slug/customer/logout',
  loadPublicTurf,
  (req, res) => {
    clearSessionCustomer(req, req.turf);
    res.json({ ok: true });
  }
);
 
/* The logged-in customer's booking history on this turf */
app.get(
  '/api/public/:slug/customer/bookings',
  loadPublicTurf,
  asyncHandler(async (req, res) => {
    const customer = await getSessionCustomer(req, req.turf);
 
    if (!customer) {
      return res.status(401).json({ message: 'Please log in to see your bookings.' });
    }
 
    const bookings = await Booking.find({ tenant: req.turf._id, customer: customer._id }).lean();
    const sessions = groupConsecutive(bookings);
 
    res.set('Cache-Control', 'no-store');
    res.json({
      bookings: sessions,
      totals: {
        bookings: sessions.length,
        hours: sessions.reduce((total, session) => total + session.hours, 0)
      }
    });
  })
);
 
/* =========================================================
   REVIEWS (public turf website)
   Anyone can read them. A logged-in customer can review once their booking is confirmed.
========================================================= */
 
/* "Asha Kulkarni" becomes "Asha K." so full names are not shown publicly */
function reviewerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : parts[0];
}
 
/* A customer may review after at least one confirmed or completed booking on a day that has started */
const hasPlayed = (tenantId, customerId) =>
  Booking.exists({
    tenant: tenantId,
    customer: customerId,
    status: { $in: ['confirmed', 'completed'] },
    date: { $lte: getLocalDateString() }
  });
 
app.get(
  '/api/public/:slug/reviews',
  loadPublicTurf,
  asyncHandler(async (req, res) => {
    const tenantId = req.turf._id;
    const customer = await getSessionCustomer(req, req.turf);
 
    const [counts, list, mine, eligible] = await Promise.all([
      Review.aggregate([
        { $match: { tenant: tenantId, hidden: false } },
        { $group: { _id: '$rating', count: { $sum: 1 } } }
      ]),
      Review.find({ tenant: tenantId, hidden: false }).sort({ createdAt: -1 }).limit(30).lean(),
      customer ? Review.findOne({ tenant: tenantId, customer: customer._id }).lean() : null,
      customer ? hasPlayed(tenantId, customer._id) : false
    ]);
 
    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    counts.forEach((row) => { breakdown[row._id] = row.count; });
 
    const total = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
    const points = Object.entries(breakdown).reduce((sum, [stars, n]) => sum + Number(stars) * n, 0);
 
    res.set('Cache-Control', 'no-store');
    res.json({
      summary: { count: total, average: total ? Math.round((points / total) * 10) / 10 : 0, breakdown },
      reviews: list.map((review) => ({
        name: reviewerName(review.customerName),
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt
      })),
      loggedIn: Boolean(customer),
      canReview: Boolean(eligible),
      mine: mine ? { rating: mine.rating, comment: mine.comment } : null
    });
  })
);
 
app.post(
  '/api/public/:slug/reviews',
  customerLimiter,
  loadPublicTurf,
  asyncHandler(async (req, res) => {
    const customer = await getSessionCustomer(req, req.turf);
 
    if (!customer) {
      return res.status(401).json({ message: 'Please log in to write a review.' });
    }
 
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Please choose a rating from 1 to 5 stars.' });
    }
 
    if (!(await hasPlayed(req.turf._id, customer._id))) {
      return res.status(403).json({ message: 'You can write a review after one of your bookings is confirmed.' });
    }
 
    const comment = String(req.body.comment || '').trim().slice(0, 500);
    const now = new Date();
 
    /* One review per customer: writing again edits it */
    await Review.findOneAndUpdate(
      { tenant: req.turf._id, customer: customer._id },
      {
        $set: { rating, comment, customerName: customer.name, updatedAt: now },
        $setOnInsert: { createdAt: now, hidden: false }
      },
      { upsert: true }
    );
 
    res.json({ message: 'Thank you for your review.' });
  })
);
 
/* =========================================================
   AUTHENTICATION
========================================================= */
 
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/onboarding');
 
  res.render('register', { title: 'Create account', error: null, values: {} });
});
 
/* Step 1 of sign-up: create the account, then verify the email at /onboarding/verify */
app.post(
  '/register',
  asyncHandler(async (req, res) => {
    const values = {
      name: String(req.body.name || '').trim().slice(0, 100),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim()
    };
    const password = String(req.body.password || '');
 
    const fail = (status, error) =>
      res.status(status).render('register', { title: 'Create account', error, values });
 
    if (!values.name || !values.email || !values.phone || !password) {
      return fail(400, 'Please fill all fields.');
    }
    if (!isValidEmail(values.email)) {
      return fail(400, 'Please enter a valid email address.');
    }
 
    const phone = normalizePhone(values.phone);
    if (!phone) {
      return fail(400, 'Please enter a valid 10-digit phone number.');
    }
    if (password.length < 8) {
      return fail(400, 'Password must be at least 8 characters.');
    }
    if (await User.exists({ email: values.email })) {
      return fail(400, 'An account with this email already exists. Please log in.');
    }
 
    let user;
    try {
      user = await User.create({
        name: values.name,
        email: values.email,
        phone,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'owner',
        emailVerified: false
      });
    } catch (error) {
      if (error.code === 11000) return fail(400, 'An account with this email already exists. Please log in.');
      throw error;
    }
 
    await startEmailVerification(user);
 
    req.session.userId = user._id.toString();
    res.redirect('/onboarding/verify');
  })
);
 
app.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: null });
});
 
app.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
 
    const fail = (status, error) => res.status(status).render('login', { title: 'Login', error });
 
    if (!email || !password) {
      return fail(400, 'Please enter your email and password.');
    }
 
    const user = await User.findOne({ email });
    const passwordMatches = user && (await bcrypt.compare(password, user.passwordHash));
 
    if (!passwordMatches) {
      return fail(401, 'Invalid email or password.');
    }
 
    req.session.userId = user._id.toString();
 
    if (user.role === 'admin') return res.redirect('/admin');
 
    /* Owners who have not finished sign-up go back to where they stopped */
    const tenant = user.tenant ? await Tenant.findById(user.tenant).lean() : null;
    res.redirect(nextStepPath(user, tenant) || '/dashboard');
  })
);
 
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});
 
/* =========================================================
   OWNER DASHBOARD
========================================================= */
 
app.get(
  '/dashboard',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;
 
    const bookings = await Booking.find({ tenant: tenant._id }).lean();
 
    const analytics = buildAnalytics(bookings, {
      range: req.query.range,
      today: getLocalDateString(),
      nowTime: getLocalTimeString(),
      openingTime: tenant.openingTime,
      closingTime: tenant.closingTime
    });
 
    const recentBookings = [...bookings]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8);
 
    res.render('dashboard', {
      title: 'Owner Dashboard',
      tenant,
      total: bookings.length,
      analytics,
      recentBookings
    });
  })
);
 
/* =========================================================
   WEBSITE SETTINGS
========================================================= */
 
app.get(
  '/dashboard/website',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.user.tenant._id).lean();
 
    res.render('website-setting', {
      title: 'Website settings',
      tenant,
      error: null,
      values: undefined
    });
  })
);
 
app.post(
  '/dashboard/website',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.user.tenant._id);
 
    if (!tenant) {
      return renderError(res, 404, 'Turf not found', 'Your turf could not be found.');
    }
 
    const body = req.body;
 
    /* Show the form again with an error, keeping what the owner typed */
    const fail = (error) =>
      res.status(400).render('website-setting', {
        title: 'Website settings',
        tenant: {
          ...tenant.toObject(),
          name: body.name || tenant.name,
          sport: body.sport || tenant.sport,
          description: body.description || '',
          address: body.address || '',
          phone: body.phone || '',
          email: body.email || '',
          pricePerHour: body.pricePerHour,
          openingTime: body.openingTime || tenant.openingTime,
          closingTime: body.closingTime || tenant.closingTime,
          logoUrl: body.logoUrl || '',
          whatsapp: body.whatsapp || '',
          instagram: body.instagram || '',
          mapUrl: body.mapUrl || '',
          refundPolicy: body.refundPolicy || ''
        },
        error,
        values: { services: body.services, images: body.images }
      });
 
    const name = String(body.name || '').trim();
    if (!name) return fail('Turf name is required.');
 
    const pricePerHour = Number(body.pricePerHour);
    if (!Number.isFinite(pricePerHour) || pricePerHour < 0) {
      return fail('Price per hour must be a number, 0 or more.');
    }
 
    const { openingTime, closingTime } = body;
    if (!isValidTime(openingTime) || !isValidTime(closingTime)) {
      return fail('Please enter valid opening and closing times.');
    }
    if (closingTime <= openingTime) {
      return fail('Closing time must be later than opening time.');
    }
 
    /* Links are shown to customers, so only safe values are accepted */
    const mapUrl = String(body.mapUrl || '').trim();
    if (mapUrl && !/^https?:\/\/\S+$/i.test(mapUrl)) {
      return fail('The map link must start with http:// or https://');
    }
 
    const instagram = String(body.instagram || '').trim();
    if (instagram && !/^(https?:\/\/(www\.)?instagram\.com\/\S+|@?[A-Za-z0-9._]{1,30})$/i.test(instagram)) {
      return fail('Instagram must be a username like @royalturf, or an instagram.com link.');
    }
 
    const whatsapp = String(body.whatsapp || '').replace(/\D/g, '');
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 15)) {
      return fail('The WhatsApp number must have 10 to 15 digits.');
    }
 
    const refundPolicy = String(body.refundPolicy || '').trim().slice(0, 1500);
 
    let services;
    try {
      services = parseServices(body.services);
    } catch (error) {
      return fail(error.message);
    }
 
    tenant.set({
      name,
      description: String(body.description || '').trim(),
      address: String(body.address || '').trim(),
      phone: String(body.phone || '').trim(),
      email: String(body.email || '').trim().toLowerCase(),
      sport: String(body.sport || '').trim() || 'Cricket',
      pricePerHour,
      openingTime,
      closingTime,
      logoUrl: String(body.logoUrl || '').trim(),
      images: parseImages(body.images),
      services,
      whatsapp,
      instagram,
      mapUrl,
      refundPolicy
    });
 
    await tenant.save();
 
    req.session.flash = 'Website settings saved.';
    res.redirect('/dashboard/website');
  })
);
 
/* =========================================================
   OWNER BOOKINGS
========================================================= */
 
app.get(
  '/dashboard/bookings',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.user.tenant._id).lean();
 
    const bookings = await Booking.find({ tenant: tenant._id })
      .sort({ date: -1, startTime: 1 })
      .lean();
 
    res.render('bookings', { title: 'Bookings', tenant, bookings });
  })
);
 
/* Manual (walk-in or phone) booking, confirmed straight away */
app.post(
  '/dashboard/bookings',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { customerName, customerPhone, customerEmail, date, startTime, endTime, amount, notes } =
      req.body;
 
    if (!customerName || !customerPhone || !date || !startTime || !endTime) {
      return renderError(res, 400, 'Invalid booking', 'Please fill all required booking fields.');
    }
    if (!isValidDateString(date) || !isValidTime(startTime) || !isValidTime(endTime)) {
      return renderError(res, 400, 'Invalid booking', 'The date or time is not valid.');
    }
    if (endTime <= startTime) {
      return renderError(res, 400, 'Invalid booking', 'End time must be after start time.');
    }
 
    const tenant = await Tenant.findById(req.user.tenant._id);
 
    if (!tenant) {
      return renderError(res, 404, 'Turf not found', 'Your turf could not be found.');
    }
 
    const clash = await Booking.exists({
      tenant: tenant._id,
      date,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime }
    });
 
    if (clash) {
      return renderError(res, 409, 'Slot unavailable', 'This time slot is already booked.');
    }
 
    const parsedAmount = Number(amount);
 
    await Booking.create({
      tenant: tenant._id,
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : '',
      date,
      startTime,
      endTime,
      amount: Number.isFinite(parsedAmount) ? parsedAmount : Number(tenant.pricePerHour || 0),
      paymentStatus: 'unpaid',
      status: 'confirmed',
      notes: notes ? String(notes).trim() : ''
    });
 
    res.redirect('/dashboard/bookings');
  })
);
 
app.post(
  '/dashboard/bookings/:id/status',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
 
    if (!BOOKING_STATUSES.includes(status)) {
      return renderError(res, 400, 'Invalid status', 'The selected booking status is invalid.');
    }
 
    const booking = await Booking.findOne({
      _id: req.params.id,
      tenant: req.user.tenant._id
    });
 
    if (!booking) {
      return renderError(res, 404, 'Booking not found', 'The booking could not be found.');
    }
 
    /* Bringing a booking back must not clash with another active booking */
    const becomesActive =
      ACTIVE_BOOKING_STATUSES.includes(status) && !ACTIVE_BOOKING_STATUSES.includes(booking.status);
 
    if (becomesActive) {
      const clash = await Booking.exists({
        _id: { $ne: booking._id },
        tenant: booking.tenant,
        date: booking.date,
        status: { $in: ACTIVE_BOOKING_STATUSES },
        startTime: { $lt: booking.endTime },
        endTime: { $gt: booking.startTime }
      });
 
      if (clash) {
        return renderError(
          res,
          409,
          'Slot unavailable',
          'Another active booking already uses this time, so this booking cannot be reopened.'
        );
      }
    }
 
    booking.status = status;
    await booking.save();
 
    res.redirect(getReturnPath(req.body.returnTo));
  })
);
 
/* Mark a booking paid or unpaid (payment gateway comes later) */
app.post(
  '/dashboard/bookings/:id/payment',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const paid = req.body.paymentStatus === 'paid';
 
    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id, tenant: req.user.tenant._id },
      { paymentStatus: paid ? 'paid' : 'unpaid', paidAt: paid ? new Date() : null }
    );
 
    if (!booking) {
      return renderError(res, 404, 'Booking not found', 'The booking could not be found.');
    }
 
    res.redirect(getReturnPath(req.body.returnTo));
  })
);
 
/* =========================================================
   ADMIN
========================================================= */
 
app.get(
  '/admin',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [tenants, owners, bookings] = await Promise.all([
      Tenant.find().populate('owner', 'name email').sort({ createdAt: -1 }).lean(),
      User.countDocuments({ role: 'owner' }),
      Booking.countDocuments()
    ]);
 
    res.render('admin', { title: 'Admin', tenants, owners, bookings });
  })
);
 
app.post(
  '/admin/tenants/:id/status',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { subscriptionStatus, isPublished } = req.body;
 
    const tenant = await Tenant.findById(req.params.id);
 
    if (!tenant) {
      return renderError(res, 404, 'Turf not found', 'The requested turf was not found.');
    }
 
    if (SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
      tenant.subscriptionStatus = subscriptionStatus;
    }
 
    if (typeof isPublished !== 'undefined') {
      tenant.isPublished = ['true', 'on', true].includes(isPublished);
    }
 
    await tenant.save();
    res.redirect('/admin');
  })
);
 
/* =========================================================
   404 AND ERROR HANDLING
========================================================= */
 
app.use((req, res) => {
  renderError(res, 404, 'Page not found', 'The page you are looking for does not exist.');
});
 
app.use((error, req, res, next) => {
  console.error('Server error:', error);
 
  if (res.headersSent) return next(error);
 
  renderError(res, 500, 'Server error', 'Something went wrong. Please try again.');
});
 
/* =========================================================
   DATABASE SETUP AND START
========================================================= */
 
const PLAN_SEED = [
  {
    key: 'basic',
    name: 'Basic',
    price: 499,
    features: [
      'Ready-made turf website',
      'SquareTurf subdomain',
      '1 ground',
      'Up to 10 photos',
      'Manual bookings',
      'Basic dashboard',
      'Email support'
    ],
    limits: { grounds: 1, photos: 10, staff: 1 },
    active: true
  },
  {
    key: 'standard',
    name: 'Standard',
    price: 999,
    features: [
      'Everything in Basic',
      'Live slot availability',
      'Online booking',
      'Payment integration',
      'Offers',
      'Booking reports'
    ],
    limits: { grounds: 2, photos: 30, staff: 3 },
    active: true
  },
  {
    key: 'premium',
    name: 'Premium',
    price: 1999,
    features: [
      'Everything in Standard',
      'Multiple grounds',
      'Staff accounts',
      'Advanced analytics',
      'Priority support'
    ],
    limits: { grounds: 10, photos: 100, staff: 10 },
    active: true
  }
];
 
async function seedPlans() {
  for (const plan of PLAN_SEED) {
    await Plan.updateOne({ key: plan.key }, { $set: plan }, { upsert: true });
  }
}
 
async function createAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@squareturf.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Admin@123';
 
  if (await User.exists({ email })) return;
 
  await User.create({
    name: 'SquareTurf Admin',
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin',
    tenant: null
  });
 
  console.log(`Admin created: ${email}`);
}
 
/* On your computer: node server.js starts the server. On Vercel the file is only imported (see api/index.js). */
if (require.main === module) {
  ensureReady()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`SquareTurf running on port ${PORT}`);
        console.log(`Base domain: ${BASE_DOMAIN}`);
      });
    })
    .catch((error) => {
      console.error('Failed to start server:', error.hint || error.message);
      process.exit(1);
    });
}
 
module.exports = app;
 