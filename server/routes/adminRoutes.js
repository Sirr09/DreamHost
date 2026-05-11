const express = require('express');
const adminController = require('../controllers/adminController');
const { protect, restrictTo } = require('../middleware/auth');

const router = express.Router();

router.use(protect, restrictTo('admin'));

router.get('/overview', adminController.overview);
router.get('/users', adminController.users);
router.patch('/users/:id/status', adminController.updateUserStatus);
router.get('/servers', adminController.servers);
router.patch('/servers/:id/status', adminController.updateServerStatus);
router.get('/invoices', adminController.invoices);
router.patch('/invoices/:id/status', adminController.updateInvoiceStatus);
router.get('/audit-logs', adminController.auditLogs);
router.get('/support-requests', adminController.supportRequests);
router.patch('/support-requests/:id', adminController.updateSupportRequest);
router.post('/support-requests/:id/reply', adminController.replySupportRequest);
router.delete('/support-requests/:id', adminController.deleteSupportRequest);

module.exports = router;
