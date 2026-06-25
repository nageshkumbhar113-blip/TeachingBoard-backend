const express            = require('express');
const ctrl               = require('../controllers/feeController');
const { requireTeacher } = require('../middleware/auth');

const router = express.Router();

// Teacher UPI settings
router.get('/upi-config',              requireTeacher, ctrl.upiConfig);
router.patch('/settings/upi',          requireTeacher, ctrl.updateUpiSettings);

// Teacher: fee config CRUD
router.post('/',                       requireTeacher, ctrl.createFeeConfig);
router.get('/',                        requireTeacher, ctrl.listFeeConfigs);
router.get('/:id/records',             requireTeacher, ctrl.getRecords);
router.post('/records/:id/payment',    requireTeacher, ctrl.addPayment);
router.patch('/records/:id/next-installment', requireTeacher, ctrl.updateNextInstallment);
router.patch('/:id/due-date',          requireTeacher, ctrl.updateDueDate);
router.post('/:id/close',              requireTeacher, ctrl.closeFeeConfig);

// Cron trigger — public, guarded by x-cron-secret header
router.post('/process-reminders',      ctrl.processReminders);

module.exports = router;
