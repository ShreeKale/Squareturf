const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  name: String,
  price: Number,
  features: [String],
  limits: { grounds: Number, photos: Number, staff: Number },
  active: { type: Boolean, default: true }
});

module.exports = mongoose.model('Plan', planSchema);