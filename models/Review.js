const mongoose = require('mongoose');

/* A star rating and short comment from a customer of one turf. One review per customer. */
const reviewSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String, required: true, trim: true, maxlength: 100 },

  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '', trim: true, maxlength: 500 },

  /* Lets a review be taken down later without deleting it */
  hidden: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

reviewSchema.index({ tenant: 1, customer: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);