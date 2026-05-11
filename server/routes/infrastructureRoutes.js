const express = require('express');
const infrastructureController = require('../controllers/infrastructureController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.get('/plans', infrastructureController.listPlans);
router.use('/servers', protect);
router.get('/servers', infrastructureController.listServers);
router.post('/servers', infrastructureController.createServer);
router.patch('/servers/:id', infrastructureController.updateServer);
router.delete('/servers/:id', infrastructureController.deleteServer);
router.patch('/servers/:id/status', infrastructureController.updateServerStatus);
router.post('/servers/:id/console', infrastructureController.runConsoleCommand);

router.use('/billing', protect);
router.get('/billing/summary', infrastructureController.billingSummary);
router.post('/billing/add-funds', infrastructureController.addFunds);

module.exports = router;
