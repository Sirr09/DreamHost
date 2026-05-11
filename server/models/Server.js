const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['vps', 'dedicated', 'cloud', 'gaming'],
    required: true,
  },
  ipAddress: String,
  status: {
    type: String,
    enum: ['provisioning', 'running', 'stopped', 'suspended', 'terminated'],
    default: 'provisioning',
  },
  resources: {
    cpu: {
      cores: Number,
      usage: { type: Number, default: 0 },
    },
    ram: {
      total: Number,
      usage: { type: Number, default: 0 },
    },
    storage: {
      total: Number,
      used: { type: Number, default: 0 },
    },
  },
  region: {
    type: String,
    required: true,
  },
  os: String,
  autoRenew: {
    type: Boolean,
    default: true,
  },
  expiresAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Server = mongoose.model('Server', serverSchema);
module.exports = Server;
