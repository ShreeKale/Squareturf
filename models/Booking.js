const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },

  customerName: { type: String, required: true, trim: true, maxlength: 100 },
  customerPhone: { type: String, required: true, trim: true, maxlength: 20 },
  customerEmail: { type: String, lowercase: true, trim: true },

  date: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },

  amount: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
    paidAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed'],
    default: 'pending'
  },

  notes: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

bookingSchema.index({ tenant: 1, date: 1, startTime: 1, endTime: 1, status: 1 });

module.exports = mongoose.model('Booking', bookingSchema);