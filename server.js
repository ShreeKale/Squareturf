require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const morgan = require('morgan');
const path = require('path');
const bcrypt = require('bcryptjs');
const slugify = require('slugify');

const User = require('./models/User');
const Tenant = require('./models/Tenant');
const Booking = require('./models/Booking');
const Plan = require('./models/Plan');

const { requireAuth, requireOwner, requireAdmin } = require('./middleware/auth');
const tenantResolver = require('./middleware/tenant');

const {
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
  makeHourlySlots,
  overlaps,
  slotKey,
  normalizeSlots,
  parseImages,
  parseServices
} = require('./utils/helpers');

const { buildAnalytics } = require('./utils/analytics');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/squareturf';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'localhost';

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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan('dev'));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'squareturf-development-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  })
);

/* Values every view can use */
app.use((req, res, next) => {
  res.locals.currentUser = null; // replaced by requireAuth on logged-in pages
  res.locals.isLoggedIn = Boolean(req.session.userId);
  res.locals.baseDomain = BASE_DOMAIN;
  res.locals.port = PORT;

  /* One-time message set with req.session.flash */
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  next();
});

/*
 * Vercel runs this app as a serverless function, so it does not execute
 * startServer(). Connect to MongoDB on demand and reuse the connection
 * between warm invocations. Local development is initialized by startServer().
 */
let databaseSetupPromise = null;

async function ensureDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (databaseSetupPromise) return databaseSetupPromise;

  databaseSetupPromise = (async () => {
    await mongoose.connect(MONGO_URI);
    await seedPlans();
    await createAdmin();
    console.log('MongoDB connected and SquareTurf data initialized');
  })();

  try {
    await databaseSetupPromise;
  } finally {
    databaseSetupPromise = null;
  }
}

app.use(async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

app.use(tenantResolver);

/* =========================================================
   HELPERS
========================================================= */

const renderError = (res, status, title, message) =>
  res.status(status).render('error', { title, message });

const getPublicTenant = (slug) =>
  slug
    ? Tenant.findOne({ slug: String(slug).toLowerCase(), isPublished: true }).lean()
    : null;

/* Hourly slots for a date, each marked available or booked */
async function getAvailability(tenant, date) {
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

app.get('/', (req, res) => {
  if (req.publicTenant) {
    return res.render('public-turf', {
      title: req.publicTenant.name,
      tenant: req.publicTenant
    });
  }

  res.render('home', { title: 'SquareTurf' });
});

app.get(
  '/turf/:slug',
  asyncHandler(async (req, res) => {
    const tenant = await getPublicTenant(req.params.slug);

    if (!tenant) {
      return renderError(res, 404, 'Turf not found', 'This turf website is unavailable.');
    }

    res.render('public-turf', { title: tenant.name, tenant });
  })
);

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

    const { customerName, customerPhone, customerEmail, date, slots } = req.body;

    if (!customerName || !customerPhone || !date || !Array.isArray(slots) || !slots.length) {
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
        customerName: String(customerName).trim(),
        customerPhone: String(customerPhone).trim(),
        customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : '',
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
   AUTHENTICATION
========================================================= */

app.get('/register', (req, res) => {
  res.render('register', { title: 'Create account', error: null, values: {} });
});

app.post(
  '/register',
  asyncHandler(async (req, res) => {
    const values = {
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim(),
      turfName: String(req.body.turfName || '').trim(),
      sport: SPORTS.includes(req.body.sport) ? req.body.sport : 'Cricket',
      slug: cleanSlug(req.body.slug),
      address: String(req.body.address || '').trim()
    };
    const password = String(req.body.password || '');

    const fail = (status, error) =>
      res.status(status).render('register', { title: 'Create account', error, values });

    if (!values.name || !values.email || !values.turfName || !password) {
      return fail(400, 'Please fill all required fields.');
    }
    if (password.length < 8) {
      return fail(400, 'Password must be at least 8 characters.');
    }

    /* Use the address the owner chose, or make one from the turf name */
    const slug =
      values.slug ||
      cleanSlug(slugify(values.turfName, { lower: true, strict: true })) ||
      `turf-${Date.now()}`;

    if (!SLUG_PATTERN.test(slug)) {
      return fail(400, 'Website address must be 3 to 40 letters, numbers or hyphens.');
    }
    if (RESERVED_SLUGS.has(slug)) {
      return fail(400, 'That website address is reserved. Please choose another.');
    }
    if (await Tenant.exists({ slug })) {
      return fail(400, 'That website address is already taken. Please choose another.');
    }
    if (await User.exists({ email: values.email })) {
      return fail(400, 'An account with this email already exists.');
    }

    const user = await User.create({
      name: values.name,
      email: values.email,
      phone: values.phone,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'owner'
    });

    try {
      const tenant = await Tenant.create({
        name: values.turfName,
        slug,
        owner: user._id,
        email: values.email,
        phone: values.phone,
        address: values.address,
        sport: values.sport,
        subscriptionStatus: 'trial',
        plan: 'basic',
        isPublished: true
      });

      user.tenant = tenant._id;
      await user.save();
    } catch (error) {
      /* Do not leave an owner without a turf behind */
      await User.deleteOne({ _id: user._id }).catch(() => {});

      if (error.code === 11000) {
        return fail(400, 'This email or website address is already in use.');
      }
      throw error;
    }

    req.session.userId = user._id.toString();
    res.redirect('/dashboard');
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
    res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
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
      bookings: recentBookings,
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
          logoUrl: body.logoUrl || ''
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
      services
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
  const configuredEmail = process.env.ADMIN_EMAIL;
  const configuredPassword = process.env.ADMIN_PASSWORD;

  /*
   * Never create a publicly deployed admin account with a predictable
   * default password. Set ADMIN_EMAIL and ADMIN_PASSWORD in Vercel instead.
   */
  if (
    process.env.NODE_ENV === 'production' &&
    (!configuredEmail || !configuredPassword)
  ) {
    console.warn('Admin creation skipped: set ADMIN_EMAIL and ADMIN_PASSWORD.');
    return;
  }

  const email = (configuredEmail || 'admin@squareturf.com').toLowerCase();
  const password = configuredPassword || 'Admin@123';

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

async function startServer() {
  try {
    await ensureDatabase();

    app.listen(PORT, () => {
      console.log(`SquareTurf running on port ${PORT}`);
      console.log(`Base domain: ${BASE_DOMAIN}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exitCode = 1;
  }
}

/*
 * Local: `node server.js` starts a normal HTTP server.
 * Vercel: imports this Express app as the serverless handler.
 */
module.exports = app;

if (require.main === module) {
  startServer();
}