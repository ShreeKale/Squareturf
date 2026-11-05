const mongoose = require('mongoose');

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const serviceSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 60 },
    icon: { type: String, default: '✓' },
    description: { type: String, trim: true, maxlength: 120 }
  },
  { _id: false }
);

/* One pricing rule: these days, from startTime to endTime (hour steps, endTime may be 24:00), this price per hour */
const pricingRuleSchema = new mongoose.Schema(
  {
    days: [{ type: String, enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }],
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    price: { type: Number, required: true, min: 1 }
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, lowercase: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  description: { type: String, default: 'Welcome to our turf.' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  /* `sports` is the list; `sport` is the same list as text ("Cricket, Football") and is kept in sync below */
  sports: [{ type: String, trim: true, maxlength: 30 }],
  sport: { type: String, default: 'Cricket' },

  /* Pin picked on the map */
  location: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 }
  },

  /* Ground setup */
  groundsCount: { type: Number, default: 1, min: 1, max: 20 },
  dimensions: {
    length: { type: Number, min: 0 },
    width: { type: Number, min: 0 },
    unit: { type: String, enum: ['ft', 'm', 'yd'], default: 'ft' }
  },
  surface: { type: String, default: '', maxlength: 40 },

  /* pricePerHour is the price for every hour ("flat"), or for hours no rule covers ("custom") */
  pricePerHour: { type: Number, default: 800, min: 0 },
  pricingMode: { type: String, enum: ['flat', 'custom'], default: 'flat' },
  pricingRules: [pricingRuleSchema],

  /* Open 24 hours is saved as 00:00 to 24:00 */
  open24Hours: { type: Boolean, default: false },
  openingTime: { type: String, default: '06:00' },
  closingTime: { type: String, default: '23:00' },
  operatingDays: {
    type: [String],
    default: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  },

  /* Website */
  logoUrl: { type: String, default: '' },
  images: [{ type: String }],
  services: [serviceSchema],
  facilitiesSet: { type: Boolean, default: false }, // true once the owner chose facilities (an empty list then means "none")
  theme: { type: String, default: 'blue' },

  /* Links and policy shown on the public website (all optional) */
  whatsapp: { type: String, default: '' },
  instagram: { type: String, default: '' },
  facebook: { type: String, default: '' },
  mapUrl: { type: String, default: '' },
  refundPolicy: { type: String, default: '', maxlength: 1500 },

  /* Plan and trial */
  subscriptionStatus: {
    type: String,
    enum: ['trial', 'active', 'past_due', 'cancelled', 'suspended'],
    default: 'trial'
  },
  plan: { type: String, enum: ['basic', 'standard', 'premium'], default: 'basic' },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + TRIAL_DAYS * DAY_MS) },
  subscriptionEndsAt: { type: Date, default: null },

  /*
   * Sign-up progress. `step` is the next step to do (2 to 6).
   * Turfs created before the sign-up flow have no saved value and count as finished.
   */
  onboarding: {
    completed: { type: Boolean, default: true },
    step: { type: Number, default: 6, min: 2, max: 6 }
  },

  isPublished: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

/* Keep `sports` (list) and `sport` (text) the same, whichever one was changed */
tenantSchema.pre('validate', function syncSports(next) {
  if (this.isModified('sports') && this.sports.length) {
    this.sport = this.sports.join(', ');
  } else if (this.isModified('sport') || !this.sports.length) {
    const list = String(this.sport || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (list.length) this.sports = list;
  }
  next();
});

module.exports = mongoose.model('Tenant', tenantSchema);
module.exports.TRIAL_DAYS = TRIAL_DAYS;