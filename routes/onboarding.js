const express = require('express');
const multer = require('multer');

const Tenant = require('../models/Tenant');
const Plan = require('../models/Plan');

const { requireAuth } = require('../middleware/auth');
const {
  RESERVED_SLUGS,
  SLUG_PATTERN,
  SPORTS,
  SURFACES,
  SIZE_UNITS,
  FACILITIES,
  asyncHandler,
  cleanSlug,
  isValidTime,
  normalizePhone,
  isValidEmail,
  readSports,
  readFacilities,
  readDimensions,
  readLocation,
  readInstagram,
  readFacebook
} = require('../utils/helpers');
const { daysLabel, hourLabel, priceSummary, readHours, readPricing } = require('../utils/pricing');
const { STEPS, STEP_PATHS, DAYS, ALL_DAYS, nextStepPath } = require('../utils/onboarding');
const { THEMES, themeFor } = require('../utils/themes');
const { saveImage, removeImage, EXTENSIONS: IMAGE_TYPES } = require('../utils/storage');
const {
  CODE_MINUTES,
  MAX_ATTEMPTS,
  mailIsConfigured,
  startEmailVerification,
  checkVerificationCode,
  resendWaitSeconds
} = require('../utils/mailer');
const { TRIAL_DAYS } = Tenant;

const router = express.Router();

const MAX_PHOTOS = 10; // gallery limit during sign-up (the Basic plan limit)
const MAX_GROUNDS = 20;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/* =========================================================
   HELPERS
========================================================= */

const STEP_TITLES = {
  verify: 'Verify your email',
  business: 'Business details',
  grounds: 'Ground setup',
  website: 'Website setup',
  plan: 'Choose your plan',
  publish: 'Preview and publish'
};

/* Every step page is rendered through here so the layout and progress bar stay the same */
function show(req, res, name, step, extra = {}) {
  const status = extra.error ? extra.status || 400 : 200;

  res.status(status).render('onboarding', {
    title: STEP_TITLES[name],
    name,
    step,
    steps: STEPS,
    user: req.user,
    tenant: req.user.tenant,
    error: null,
    values: {},
    ...extra
  });
}

/* Moves the owner forward, never backwards, when they save a step */
function advanceTo(tenant, step) {
  tenant.onboarding.step = Math.max(tenant.onboarding.step, step);
}

/* =========================================================
   ACCESS RULES
========================================================= */

router.use(requireAuth, (req, res, next) => {
  if (req.user.role !== 'owner') return res.redirect('/admin');
  next();
});

/* Steps 2 to 6 need a verified email */
const requireVerified = (req, res, next) => {
  if (req.user.emailVerified === false) return res.redirect('/onboarding/verify');
  next();
};

/* Steps 3 to 6 also need the earlier steps saved. Finished turfs go to the dashboard. */
const requireStep = (step) => (req, res, next) => {
  const tenant = req.user.tenant;

  if (tenant && tenant.onboarding.completed !== false) return res.redirect('/dashboard');
  if (!tenant || tenant.onboarding.step < step) return res.redirect(nextStepPath(req.user, tenant));

  next();
};

/* A finished turf cannot go through sign-up again */
const requireUnfinished = (req, res, next) => {
  const tenant = req.user.tenant;
  if (tenant && tenant.onboarding.completed !== false) return res.redirect('/dashboard');
  next();
};

router.get('/', (req, res) => {
  res.redirect(nextStepPath(req.user, req.user.tenant) || '/dashboard');
});

/* =========================================================
   STEP 1: VERIFY EMAIL (the account itself is made on /register)
========================================================= */

router.get('/verify', (req, res) => {
  if (req.user.emailVerified !== false) return res.redirect('/onboarding');

  show(req, res, 'verify', 1, {
    mailConfigured: mailIsConfigured(),
    codeMinutes: CODE_MINUTES,
    waitSeconds: resendWaitSeconds(req.user)
  });
});

router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.emailVerified !== false) return res.redirect('/onboarding');

    const fail = (error) =>
      show(req, res, 'verify', 1, {
        error,
        mailConfigured: mailIsConfigured(),
        codeMinutes: CODE_MINUTES,
        waitSeconds: resendWaitSeconds(user)
      });

    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) return fail('Enter the 6-digit code from your email.');

    const result = checkVerificationCode(user, code);

    if (result === 'expired') return fail('This code has expired. Request a new one.');
    if (result === 'locked') return fail('Too many wrong attempts. Request a new code.');

    if (result === 'wrong') {
      user.emailVerify.attempts += 1;
      await user.save();

      const left = MAX_ATTEMPTS - user.emailVerify.attempts;
      return fail(left > 0 ? `That code is not right. ${left} attempts left.` : 'Too many wrong attempts. Request a new code.');
    }

    user.emailVerified = true;
    user.emailVerify = { codeHash: '', expiresAt: null, sentAt: null, attempts: 0 };
    await user.save();

    res.redirect(STEP_PATHS[2]);
  })
);

router.post(
  '/verify/resend',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.emailVerified !== false) return res.redirect('/onboarding');

    const wait = resendWaitSeconds(user);
    if (wait > 0) {
      return show(req, res, 'verify', 1, {
        error: `Please wait ${wait} seconds before asking for another code.`,
        status: 429,
        mailConfigured: mailIsConfigured(),
        codeMinutes: CODE_MINUTES,
        waitSeconds: wait
      });
    }

    await startEmailVerification(user);

    req.session.flash = 'A new code is on its way.';
    res.redirect('/onboarding/verify');
  })
);

/* =========================================================
   STEP 2: BUSINESS DETAILS
========================================================= */

router.get('/slug-check', requireVerified, asyncHandler(async (req, res) => {
  const slug = cleanSlug(req.query.slug);

  if (!SLUG_PATTERN.test(slug)) {
    return res.json({ available: false, message: 'Use 3 to 40 letters, numbers or hyphens.' });
  }
  if (RESERVED_SLUGS.has(slug)) {
    return res.json({ available: false, message: 'That address is reserved.' });
  }

  const own = req.user.tenant ? { _id: { $ne: req.user.tenant._id } } : {};
  const taken = await Tenant.exists({ slug, ...own });

  res.json({
    available: !taken,
    message: taken ? 'That address is already taken.' : 'This address is available.'
  });
}));

/* Sports of a saved turf as form values: ticked sports, and any custom names for the "Other" box */
function sportValues(tenant) {
  const saved = tenant && tenant.sports && tenant.sports.length ? [...tenant.sports] : [];
  const known = saved.filter((sport) => SPORTS.includes(sport) && sport !== 'Other');
  const custom = saved.filter((sport) => !SPORTS.includes(sport));

  return {
    sports: custom.length ? [...known, 'Other'] : known,
    otherSport: custom.join(', ')
  };
}

const businessValues = (user, tenant) => ({
  name: tenant ? tenant.name : '',
  ...sportValues(tenant),
  slug: tenant ? tenant.slug : '',
  address: tenant ? tenant.address : '',
  lat: tenant && tenant.location && tenant.location.lat != null ? tenant.location.lat : '',
  lng: tenant && tenant.location && tenant.location.lng != null ? tenant.location.lng : '',
  phone: (tenant && tenant.phone) || user.phone || '',
  email: (tenant && tenant.email) || user.email
});

const businessView = (req, res, extra = {}) =>
  show(req, res, 'business', 2, { sportList: SPORTS, ...extra });

router.get('/business', requireVerified, requireUnfinished, (req, res) => {
  businessView(req, res, { values: businessValues(req.user, req.user.tenant) });
});

router.post(
  '/business',
  requireVerified,
  requireUnfinished,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const existing = user.tenant;

    const values = {
      name: String(req.body.name || '').trim().slice(0, 120),
      sports: [].concat(req.body.sports || []).map(String),
      otherSport: String(req.body.otherSport || '').slice(0, 120),
      slug: cleanSlug(req.body.slug),
      address: String(req.body.address || '').trim().slice(0, 300),
      lat: String(req.body.lat || ''),
      lng: String(req.body.lng || ''),
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase()
    };

    const fail = (error) => businessView(req, res, { error, values });

    if (!values.name) return fail('Please enter your turf or business name.');

    const sportCheck = readSports(req.body);
    if (sportCheck.error) return fail(sportCheck.error);

    const locationCheck = readLocation(req.body);
    if (locationCheck.error) return fail(locationCheck.error);
    if (!values.address) return fail('The address could not be found for that spot. Please type it in the address box.');

    const phone = normalizePhone(values.phone);
    if (!phone) return fail('Please enter a valid 10-digit contact number.');
    if (!isValidEmail(values.email)) return fail('Please enter a valid contact email.');

    if (!SLUG_PATTERN.test(values.slug)) return fail('Website address must be 3 to 40 letters, numbers or hyphens.');
    if (RESERVED_SLUGS.has(values.slug)) return fail('That website address is reserved. Please choose another.');

    const taken = await Tenant.exists({
      slug: values.slug,
      ...(existing ? { _id: { $ne: existing._id } } : {})
    });
    if (taken) return fail('That website address is already taken. Please choose another.');

    const details = {
      name: values.name,
      sports: sportCheck.sports,
      sport: sportCheck.sports.join(', '),
      slug: values.slug,
      address: values.address,
      location: locationCheck.location,
      phone,
      email: values.email
    };

    try {
      if (existing) {
        existing.set(details);
        advanceTo(existing, 3);
        await existing.save();
      } else {
        const tenant = await Tenant.create({
          ...details,
          owner: user._id,
          isPublished: false, // goes live in step 6
          onboarding: { completed: false, step: 3 }
        });

        user.tenant = tenant._id;
        await user.save();
      }
    } catch (error) {
      if (error.code === 11000) return fail('That website address is already taken. Please choose another.');
      throw error;
    }

    res.redirect(STEP_PATHS[3]);
  })
);

/* =========================================================
   STEP 3: GROUND SETUP
========================================================= */

const groundsView = (req, res, extra = {}) =>
  show(req, res, 'grounds', 3, {
    days: DAYS,
    surfaces: SURFACES,
    sizeUnits: SIZE_UNITS,
    facilityList: FACILITIES,
    ...extra
  });

router.get('/grounds', requireVerified, requireStep(3), (req, res) => {
  const tenant = req.user.tenant;
  const size = tenant.dimensions || {};

  groundsView(req, res, {
    values: {
      groundsCount: tenant.groundsCount,
      length: size.length || '',
      width: size.width || '',
      unit: size.unit || 'ft',
      surface: tenant.surface || '',
      facilities: tenant.facilitiesSet ? tenant.services.map((service) => service.name) : [],
      pricingMode: tenant.pricingMode,
      pricePerHour: tenant.pricePerHour,
      pricingRules: tenant.pricingRules.map((rule) => ({
        days: [...rule.days], startTime: rule.startTime, endTime: rule.endTime, price: rule.price
      })),
      open24Hours: tenant.open24Hours,
      openingTime: tenant.openingTime,
      closingTime: tenant.closingTime,
      operatingDays: tenant.operatingDays
    }
  });
});

router.post(
  '/grounds',
  requireVerified,
  requireStep(3),
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;

    const operatingDays = [...new Set([].concat(req.body.operatingDays || []))].filter((day) =>
      ALL_DAYS.includes(day)
    );

    /* What the owner typed, so the form can be shown again with an error */
    let typedRules = [];
    try {
      const parsed = JSON.parse(String(req.body.pricingRules || '[]'));
      if (Array.isArray(parsed)) typedRules = parsed.slice(0, 12);
    } catch { /* shown as no rules */ }

    const values = {
      groundsCount: req.body.groundsCount,
      length: String(req.body.length || ''),
      width: String(req.body.width || ''),
      unit: String(req.body.unit || 'ft'),
      surface: String(req.body.surface || ''),
      facilities: [].concat(req.body.facilities || []).map(String),
      pricingMode: req.body.pricingMode === 'custom' ? 'custom' : 'flat',
      pricePerHour: req.body.pricePerHour,
      pricingRules: typedRules,
      open24Hours: req.body.open24Hours === '1',
      openingTime: String(req.body.openingTime || ''),
      closingTime: String(req.body.closingTime || ''),
      operatingDays
    };

    const fail = (error) => groundsView(req, res, { error, values });

    const groundsCount = Number(values.groundsCount);
    if (!Number.isInteger(groundsCount) || groundsCount < 1 || groundsCount > MAX_GROUNDS) {
      return fail(`Number of grounds must be a whole number from 1 to ${MAX_GROUNDS}.`);
    }

    const size = readDimensions(req.body);
    if (size.error) return fail(size.error);

    if (!SURFACES.includes(values.surface)) return fail('Please select the ground surface.');

    const hours = readHours(req.body, isValidTime);
    if (hours.error) return fail(hours.error);
    if (!operatingDays.length) return fail('Select at least one day you are open.');

    const pricing = readPricing(req.body);
    if (pricing.error) return fail(pricing.error);

    tenant.set({
      groundsCount,
      dimensions: size.dimensions,
      surface: values.surface,
      services: readFacilities(req.body),
      facilitiesSet: true,
      pricePerHour: pricing.pricePerHour,
      pricingMode: pricing.pricingMode,
      pricingRules: pricing.pricingRules,
      open24Hours: hours.open24Hours,
      openingTime: hours.openingTime,
      closingTime: hours.closingTime,
      operatingDays
    });
    advanceTo(tenant, 4);
    await tenant.save();

    res.redirect(STEP_PATHS[4]);
  })
);

/* =========================================================
   STEP 4: WEBSITE (logo, photos, description, theme)
========================================================= */

/* Files are held in memory while the form is checked, then saved with utils/storage.js
   (Vercel Blob when live, the public/uploads folder on your computer). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_PHOTOS + 1 },
  fileFilter: (req, file, cb) =>
    IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG or WebP images are allowed.'))
}).fields([
  { name: 'logo', maxCount: 1 },
  { name: 'photos', maxCount: MAX_PHOTOS }
]);

/* Runs the upload and keeps any problem for the route to show, instead of a crash page */
function handleUpload(req, res, next) {
  upload(req, res, (error) => {
    if (error) {
      req.uploadError =
        error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 4 MB or smaller.'
        : error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT' ? `You can upload up to ${MAX_PHOTOS} photos.`
        : error.message;
    }
    next();
  });
}

const websiteView = (req, res, extra = {}) =>
  show(req, res, 'website', 4, {
    themes: THEMES,
    maxPhotos: MAX_PHOTOS,
    maxImageMb: MAX_IMAGE_BYTES / (1024 * 1024),
    ...extra
  });

router.get('/website', requireVerified, requireStep(4), (req, res) => {
  const tenant = req.user.tenant;
  const hasDescription = tenant.description && tenant.description !== 'Welcome to our turf.';

  websiteView(req, res, {
    values: {
      description: hasDescription ? tenant.description : '',
      theme: themeFor(tenant.theme).key,
      instagram: tenant.instagram || '',
      facebook: tenant.facebook || ''
    }
  });
});

router.post(
  '/website',
  requireVerified,
  requireStep(4),
  handleUpload,
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;

    const files = req.files || {};
    const newLogo = (files.logo || [])[0] || null;
    const newPhotos = files.photos || [];

    const values = {
      description: String(req.body.description || '').trim(),
      theme: String(req.body.theme || ''),
      instagram: String(req.body.instagram || '').trim(),
      facebook: String(req.body.facebook || '').trim()
    };

    const fail = (error) => websiteView(req, res, { error, values });

    if (req.uploadError) return fail(req.uploadError);

    if (values.description.length < 20) return fail('Write a short description of your turf (at least 20 characters).');
    if (values.description.length > 1000) return fail('The description can be up to 1000 characters.');
    if (!THEMES[values.theme]) return fail('Please select a theme.');

    /* Social links are optional, and shown to customers, so only safe values are saved */
    const instagram = readInstagram(values.instagram);
    if (instagram.error) return fail(instagram.error);
    const facebook = readFacebook(values.facebook);
    if (facebook.error) return fail(facebook.error);

    /* Only photos this turf really has can be removed */
    const removed = new Set([].concat(req.body.removePhotos || []).map(String).filter((url) => tenant.images.includes(url)));
    const keptPhotos = tenant.images.filter((url) => !removed.has(url));

    if (keptPhotos.length + newPhotos.length > MAX_PHOTOS) {
      return fail(`You can have up to ${MAX_PHOTOS} photos. Remove some or upload fewer.`);
    }

    /* Everything is valid: save the new images */
    const savedUrls = [];
    try {
      const logoUrl = newLogo ? await saveImage(tenant._id, newLogo) : null;
      if (logoUrl) savedUrls.push(logoUrl);

      const photoUrls = [];
      for (const file of newPhotos) {
        const url = await saveImage(tenant._id, file);
        savedUrls.push(url);
        photoUrls.push(url);
      }

      /* Logo: a new file replaces the old one, or the owner can remove it */
      const oldLogo = tenant.logoUrl;
      if (logoUrl) tenant.logoUrl = logoUrl;
      else if (req.body.removeLogo === '1') tenant.logoUrl = '';

      tenant.images = [...keptPhotos, ...photoUrls];
      tenant.description = values.description;
      tenant.theme = values.theme;
      tenant.instagram = instagram.value;
      tenant.facebook = facebook.value;
      advanceTo(tenant, 5);
      await tenant.save();

      /* Only after saving: remove the files that are no longer used */
      if (oldLogo && oldLogo !== tenant.logoUrl) await removeImage(tenant._id, oldLogo);
      for (const url of removed) await removeImage(tenant._id, url);
    } catch (error) {
      console.error('Website step failed:', error.message);
      for (const url of savedUrls) await removeImage(tenant._id, url); // do not leave unused files behind
      return fail('Your images could not be saved. Please try again.');
    }

    res.redirect(STEP_PATHS[5]);
  })
);

/* =========================================================
   STEP 5: PLAN
========================================================= */

const loadPlans = () => Plan.find({ active: true }).sort({ price: 1 }).lean();

router.get(
  '/plan',
  requireVerified,
  requireStep(5),
  asyncHandler(async (req, res) => {
    show(req, res, 'plan', 5, {
      plans: await loadPlans(),
      trialDays: TRIAL_DAYS,
      values: { plan: req.user.tenant.plan }
    });
  })
);

router.post(
  '/plan',
  requireVerified,
  requireStep(5),
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;
    const plans = await loadPlans();
    const chosen = plans.find((plan) => plan.key === req.body.plan);

    const fail = (error) =>
      show(req, res, 'plan', 5, {
        error,
        plans,
        trialDays: TRIAL_DAYS,
        values: { plan: req.body.plan }
      });

    if (!chosen) return fail('Please choose a plan.');

    const grounds = chosen.limits && chosen.limits.grounds;
    if (grounds && tenant.groundsCount > grounds) {
      return fail(
        `You set up ${tenant.groundsCount} grounds, but ${chosen.name} includes ${grounds}. ` +
        'Choose a bigger plan, or go back and change the number of grounds.'
      );
    }

    const photos = chosen.limits && chosen.limits.photos;
    if (photos && tenant.images.length > photos) {
      return fail(`${chosen.name} includes ${photos} photos, and you have ${tenant.images.length}.`);
    }

    tenant.plan = chosen.key;
    advanceTo(tenant, 6);
    await tenant.save();

    res.redirect(STEP_PATHS[6]);
  })
);

/* =========================================================
   STEP 6: PREVIEW AND PUBLISH
========================================================= */

/* The page inside the preview frame: the real public website, shown before it is live */
router.get('/preview', requireVerified, requireStep(6), (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.render('public-turf', {
    title: req.user.tenant.name,
    tenant: req.user.tenant.toObject(),
    customer: null,
    theme: themeFor(req.user.tenant.theme),
    pricing: priceSummary(req.user.tenant.toObject()),
    preview: true
  });
});

router.get(
  '/publish',
  requireVerified,
  requireStep(6),
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;
    const plan = await Plan.findOne({ key: tenant.plan }).lean();

    show(req, res, 'publish', 6, {
      plan,
      trialDays: TRIAL_DAYS,
      themeLabel: themeFor(tenant.theme).label,
      daysLabel,
      hourLabel
    });
  })
);

router.post(
  '/publish',
  requireVerified,
  requireStep(6),
  asyncHandler(async (req, res) => {
    const tenant = req.user.tenant;

    tenant.isPublished = true;
    tenant.onboarding.completed = true;
    tenant.subscriptionStatus = 'trial';
    tenant.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000); // trial starts now
    await tenant.save();

    req.session.flash = 'Your website is live! Share your link with your customers.';
    res.redirect('/dashboard');
  })
);

module.exports = router;