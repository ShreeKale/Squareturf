const mongoose = require('mongoose');

/*
 * A visitor of one turf website who registered to book faster.
 * Accounts belong to a single turf: the same phone number can register on different turfs.
 */
const customerSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true }, // 10 digits, see normalizePhone()
  createdAt: { type: Date, default: Date.now }
});

/* One account per phone number on each turf */
customerSchema.index({ tenant: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);