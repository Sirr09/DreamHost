const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/admin-login', authController.adminLogin);
router.post('/logout', authController.logout);
router.get('/me', protect, authController.me);
router.patch('/me', protect, authController.updateMe);

module.exports = router;
