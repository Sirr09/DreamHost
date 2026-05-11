const express = require('express');
const rateLimit = require('express-rate-limit');
const supportController = require('../controllers/supportController');
const { protect } = require('../middleware/auth');

const router = express.Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'fail', message: 'Too many chat messages. Please wait a moment.' },
});

router.post('/chat', chatLimiter, supportController.chat);
router.post('/admin-contact', chatLimiter, supportController.adminContact);
router.get('/tickets', protect, supportController.listTickets);
router.post('/tickets', protect, supportController.createTicket);
router.post('/tickets/:id/messages', protect, supportController.replyTicket);
router.patch('/tickets/:id/close', protect, supportController.closeTicket);

module.exports = router;
