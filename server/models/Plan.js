const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['vps', 'dedicated', 'cloud', 'gaming'],
    required: true,
  },
  price: {
    monthly: Number,
    yearly: Number,
  },
  specs: {
    cpu: String,
    ram: String,
    storage: String,
    bandwidth: String,
    network: String,
  },
  features: [String],
  isPopular: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  stock: {
    type: Number,
    default: -1, // -1 for unlimited
  },
});

const Plan = mongoose.model('Plan', planSchema);
module.exports = Plan;
