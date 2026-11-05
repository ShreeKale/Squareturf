/*
 * Website settings: the owner can change everything they entered while signing up
 * (business, sports, location, ground, facilities, hours, pricing, photos, theme, links).
 * Lives at /dashboard/website.
 */
const express = require('express');
const multer = require('multer');

const Tenant = require('../models/Tenant');
const Plan = require('../models/Plan');

const { requireAuth, requireOwner } = require('../middleware/auth');
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
  isValidEmail,
  normalizePhone,
  readSports,
  readFacilities,
  readDimensions,
  readLocation,
  readInstagram,
  readFacebook
} = require('../utils/helpers');
const { DAYS, ALL_DAYS } = require('../utils/onboarding');
const { THEMES } = require('../utils/themes');
const { readHours, readPricing } = require('../utils/pricing');
const { saveImage, removeImage, EXTENSIONS: IMAGE_TYPES } = require('../utils/storage');

const router = express.Router();

const MAX_UPLOAD = 10;                    // photos in one save
const DEFAULT_MAX_PHOTOS = 10;            // used when the plan has no photo limit saved
const MAX_GROUNDS = 20;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

router.use(requireAuth, requireOwner);

/* ---------- Uploads (kept in memory, then saved with utils/storage.js) ---------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_UPLOAD + 1 },
  fileFilter: (req, file, cb) =>
    IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG or WebP images are allowed.'))
}).fields([
  { name: 'logo', maxCount: 1 },
  { name: 'photos', maxCount: MAX_UPLOAD }
]);

function handleUpload(req, res, next) {
  upload(req, res, (error) => {
    if (error) {
      req.uploadError =
        error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 4 MB or smaller.'
        : error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT' ? `You can upload up to ${MAX_UPLOAD} photos at a time.`
        : error.message;
    }
    next();
  });
}

/* ---------- Form values ---------- */

/* Sports as form values: ticked sports, plus any own names for the "Other" box */
function sportValues(list) {
  const saved = Array.isArray(list) ? list : [];
  const known = saved.filter((sport) => SPORTS.includes(sport) && sport !== 'Other');
  const custom = saved.filter((sport) => !SPORTS.includes(sport));

  return { sports: custom.length ? [...known, 'Other'] : known, otherSport: custom.join(', ') };
}

const sportsOf = (tenant) =>
  tenant.sports && tenant.sports.length
    ? [...tenant.sports]
    : String(tenant.sport || '').split(',').map((name) => name.trim()).filter(Boolean);

/* What the form shows for a saved turf */
function valuesFromTenant(tenant) {
  const size = tenant.dimensions || {};
  const loc = tenant.location || {};
  const has = (n) => n !== undefined && n !== null;

  return {
    name: tenant.name,
    slug: tenant.slug,
    ...sportValues(sportsOf(tenant)),
    phone: tenant.phone || '',
    email: tenant.email || '',
    whatsapp: tenant.whatsapp || '',
    description: tenant.description || '',
    address: tenant.address || '',
    lat: has(loc.lat) ? loc.lat : '',
    lng: has(loc.lng) ? loc.lng : '',
    mapUrl: tenant.mapUrl || '',
    groundsCount: tenant.groundsCount || 1,
    length: size.length || '',
    width: size.width || '',
    unit: size.unit || 'ft',
    surface: tenant.surface || '',
    facilities: (tenant.services || []).map((service) => service.name),
    open24Hours: !!tenant.open24Hours,
    openingTime: tenant.openingTime || '06:00',
    closingTime: tenant.closingTime || '23:00',
    pricingMode: tenant.pricingMode === 'custom' ? 'custom' : 'flat',
    pricePerHour: tenant.pricePerHour,
    pricingRules: (tenant.pricingRules || []).map((rule) => ({
      days: [...rule.days], startTime: rule.startTime, endTime: rule.endTime, price: rule.price
    })),
    operatingDays: tenant.operatingDays || [],
    theme: THEMES[tenant.theme] ? tenant.theme : 'blue',
    instagram: tenant.instagram || '',
    facebook: tenant.facebook || '',
    refundPolicy: tenant.refundPolicy || ''
  };
}

/* What the owner typed, so the form can be shown again when something is wrong */
function valuesFromBody(body) {
  let rules = [];
  try {
    const parsed = JSON.parse(String(body.pricingRules || '[]'));
    if (Array.isArray(parsed)) rules = parsed.slice(0, 12);
  } catch { /* shown as no rules */ }

  const text = (key, max = 300) => String(body[key] || '').slice(0, max);
  const list = (key) => [].concat(body[key] || []).map(String);

  return {
    name: text('name', 120),
    slug: cleanSlug(body.slug),
    sports: list('sports'),
    otherSport: text('otherSport', 120),
    phone: text('phone', 30),
    email: text('email', 120),
    whatsapp: text('whatsapp', 30),
    description: text('description', 1000),
    address: text('address'),
    lat: text('lat', 20),
    lng: text('lng', 20),
    mapUrl: text('mapUrl', 500),
    groundsCount: text('groundsCount', 5),
    length: text('length', 10),
    width: text('width', 10),
    unit: text('unit', 3),
    surface: text('surface', 40),
    facilities: list('facilities'),
    open24Hours: body.open24Hours === '1',
    openingTime: text('openingTime', 5),
    closingTime: text('closingTime', 5),
    pricingMode: body.pricingMode === 'custom' ? 'custom' : 'flat',
    pricePerHour: body.pricePerHour,
    pricingRules: rules,
    operatingDays: list('operatingDays').filter((day) => ALL_DAYS.includes(day)),
    theme: text('theme', 20),
    instagram: text('instagram', 200),
    facebook: text('facebook', 200),
    refundPolicy: text('refundPolicy', 1500)
  };
}

/* Plan limits (grounds and photos) for this turf */
async function limitsFor(tenant) {
  const plan = await Plan.findOne({ key: tenant.plan }).lean();
  const limits = (plan && plan.limits) || {};
  return {
    planName: plan ? plan.name : tenant.plan,
    grounds: limits.grounds || MAX_GROUNDS,
    photos: limits.photos || DEFAULT_MAX_PHOTOS
  };
}

/* Standard facilities, plus any older facility the owner wrote themselves (so it is not lost) */
const facilityChoices = (tenant) => {
  const known = new Set(FACILITIES.map((item) => item.name));
  const own = (tenant.services || [])
    .filter((service) => service && service.name && !known.has(service.name))
    .map((service) => ({ name: service.name, description: service.description || '', icon: service.icon || '✓' }));
  return { own, list: [...FACILITIES, ...own] };
};

async function showForm(req, res, tenant, values, extra = {}) {
  const limits = await limitsFor(tenant);
  const plain = tenant.toObject ? tenant.toObject() : tenant;

  res.status(extra.error ? 400 : 200).render('website-setting', {
    title: 'Website settings',
    tenant: plain,
    values,
    error: null,
    themes: THEMES,
    sportList: SPORTS,
    surfaces: SURFACES,
    sizeUnits: SIZE_UNITS,
    facilityList: facilityChoices(plain).list,
    days: DAYS,
    maxPhotos: limits.photos,
    maxGrounds: limits.grounds,
    planName: limits.planName,
    maxImageMb: MAX_IMAGE_BYTES / (1024 * 1024),
    ...extra
  });
}

const loadTenant = (req) => Tenant.findById(req.user.tenant._id);

/* =========================================================
   PAGE
========================================================= */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).render('error', { title: 'Turf not found', message: 'Your turf could not be found.' });

    await showForm(req, res, tenant, valuesFromTenant(tenant));
  })
);

/* =========================================================
   SAVE
========================================================= */

router.post(
  '/',
  handleUpload,
  asyncHandler(async (req, res) => {
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).render('error', { title: 'Turf not found', message: 'Your turf could not be found.' });

    const body = req.body;
    const values = valuesFromBody(body);
    const fail = (error) => showForm(req, res, tenant, values, { error });

    const files = req.files || {};
    const newLogo = (files.logo || [])[0] || null;
    const newPhotos = files.photos || [];

    if (req.uploadError) return fail(req.uploadError);

    /* ----- Business ----- */
    const name = values.name.trim();
    if (!name) return fail('Please enter your turf or business name.');

    if (!SLUG_PATTERN.test(values.slug)) return fail('Website address must be 3 to 40 letters, numbers or hyphens.');
    if (values.slug !== tenant.slug) {
      if (RESERVED_SLUGS.has(values.slug)) return fail('That website address is reserved. Please choose another.');
      if (await Tenant.exists({ slug: values.slug, _id: { $ne: tenant._id } })) {
        return fail('That website address is already taken. Please choose another.');
      }
    }

    const sportCheck = readSports(body);
    if (sportCheck.error) return fail(sportCheck.error);

    const phone = normalizePhone(values.phone);
    if (!phone) return fail('Please enter a valid 10-digit contact number.');
    const email = values.email.trim().toLowerCase();
    if (!isValidEmail(email)) return fail('Please enter a valid contact email.');

    const whatsapp = values.whatsapp.replace(/\D/g, '');
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 15)) return fail('The WhatsApp number must have 10 to 15 digits.');

    const description = values.description.trim();
    if (description.length > 1000) return fail('The description can be up to 1000 characters.');

    /* ----- Location ----- */
    const address = values.address.trim();
    if (!address) return fail('Please pick your turf on the map, or type the address.');

    /* Older turfs have no map pin yet, so the pin is optional for them until they set one */
    const hadPin = tenant.location && tenant.location.lat != null && tenant.location.lng != null;
    const pinSent = values.lat !== '' || values.lng !== '';
    let location;
    if (hadPin || pinSent) {
      const pin = readLocation(body);
      if (pin.error) return fail(pin.error);
      location = pin.location;
    }

    const mapUrl = values.mapUrl.trim();
    if (mapUrl && !/^https?:\/\/\S+$/i.test(mapUrl)) return fail('The map link must start with http:// or https://');

    /* ----- Ground ----- */
    const limits = await limitsFor(tenant);
    const groundsCount = Number(values.groundsCount);
    if (!Number.isInteger(groundsCount) || groundsCount < 1 || groundsCount > MAX_GROUNDS) {
      return fail(`Number of grounds must be a whole number from 1 to ${MAX_GROUNDS}.`);
    }
    if (groundsCount > limits.grounds) {
      return fail(`Your ${limits.planName} plan includes ${limits.grounds} ground${limits.grounds === 1 ? '' : 's'}. Choose a bigger plan to add more.`);
    }

    /* Size and surface are optional here (older turfs do not have them), but a size needs both numbers */
    let dimensions;
    if (values.length !== '' || values.width !== '') {
      const size = readDimensions(body);
      if (size.error) return fail(size.error);
      dimensions = size.dimensions;
    }
    if (values.surface && !SURFACES.includes(values.surface)) return fail('Please choose a surface from the list.');

    const hours = readHours(body, isValidTime);
    if (hours.error) return fail(hours.error);
    if (!values.operatingDays.length) return fail('Select at least one day you are open.');

    const pricing = readPricing(body, { allowZero: true });
    if (pricing.error) return fail(pricing.error);

    const services = readFacilities(body, facilityChoices(tenant).own);

    /* ----- Website ----- */
    if (!THEMES[values.theme]) return fail('Please select a theme.');

    const instagram = readInstagram(values.instagram);
    if (instagram.error) return fail(instagram.error);
    const facebook = readFacebook(values.facebook);
    if (facebook.error) return fail(facebook.error);

    const refundPolicy = values.refundPolicy.trim().slice(0, 1500);

    /* Only photos this turf really has can be removed */
    const removed = new Set([].concat(body.removePhotos || []).map(String).filter((url) => tenant.images.includes(url)));
    const keptPhotos = tenant.images.filter((url) => !removed.has(url));
    if (keptPhotos.length + newPhotos.length > limits.photos) {
      return fail(`Your ${limits.planName} plan includes ${limits.photos} photos. Remove some or upload fewer.`);
    }

    /* ----- Everything is valid: save the images, then the turf ----- */
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

      const oldLogo = tenant.logoUrl;
      let nextLogo = tenant.logoUrl;
      if (logoUrl) nextLogo = logoUrl;
      else if (body.removeLogo === '1') nextLogo = '';

      const update = {
        name,
        slug: values.slug,
        sports: sportCheck.sports,
        sport: sportCheck.sports.join(', '),
        phone,
        email,
        whatsapp,
        description,
        address,
        mapUrl,
        groundsCount,
        surface: values.surface,
        services,
        facilitiesSet: true,
        pricePerHour: pricing.pricePerHour,
        pricingMode: pricing.pricingMode,
        pricingRules: pricing.pricingRules,
        open24Hours: hours.open24Hours,
        openingTime: hours.openingTime,
        closingTime: hours.closingTime,
        operatingDays: values.operatingDays,
        theme: values.theme,
        instagram: instagram.value,
        facebook: facebook.value,
        refundPolicy,
        logoUrl: nextLogo,
        images: [...keptPhotos, ...photoUrls]
      };
      if (location) update.location = location;
      if (dimensions) update.dimensions = dimensions;

      tenant.set(update);
      await tenant.save();

      /* Only after saving: remove the files that are no longer used */
      if (oldLogo && oldLogo !== nextLogo) await removeImage(tenant._id, oldLogo);
      for (const url of removed) await removeImage(tenant._id, url);
    } catch (error) {
      console.error('Website settings failed:', error.message);
      for (const url of savedUrls) await removeImage(tenant._id, url); // do not leave unused files behind

      if (error.code === 11000) return fail('That website address is already taken. Please choose another.');
      return fail(
        /Image storage is not set up/.test(error.message)
          ? error.message
          : 'Your changes could not be saved. Please try again.'
      );
    }

    req.session.flash = 'Website settings saved.';
    res.redirect('/dashboard/website');
  })
);

module.exports = router;