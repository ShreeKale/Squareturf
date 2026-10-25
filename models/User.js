const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'admin'], default: 'owner' },
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },

  /* Accounts that existed before email verification count as verified; sign-up sets this to false */
  emailVerified: { type: Boolean, default: true },
  emailVerify: {
    codeHash: { type: String, default: '' },
    expiresAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 }
  },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);