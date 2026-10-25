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

const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, lowercase: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  description: { type: String, default: 'Welcome to our turf.' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  sport: { type: String, default: 'Cricket' },

  /* Ground setup */
  groundsCount: { type: Number, default: 1, min: 1, max: 20 },
  pricePerHour: { type: Number, default: 800, min: 0 },
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
  theme: { type: String, default: 'blue' },

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

module.exports = mongoose.model('Tenant', tenantSchema);
module.exports.TRIAL_DAYS = TRIAL_DAYS;