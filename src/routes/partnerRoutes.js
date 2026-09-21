const express = require('express');
const { requireAdmin, requireTeacher } = require('../middleware/auth');
const c = require('../controllers/partnerController');

const router = express.Router();

// Partner (logged-in teacher) - own earnings and payout details
router.get('/me/earnings',        requireTeacher, c.getMyEarnings);
router.put('/me/payout-profile',  requireTeacher, c.setMyPayoutProfile);

// External scheduler (shared secret)
router.post('/cron/close-month',  c.cronCloseMonth);

// Admin
router.get('/config',               requireAdmin, c.getPartnerConfig);
router.put('/config',               requireAdmin, c.setPartnerConfig);
router.get('/',                     requireAdmin, c.listPartners);
router.get('/statements',           requireAdmin, c.listStatements);
router.post('/statements/close',    requireAdmin, c.closeMonthNow);
router.post('/statements/:id/paid', requireAdmin, c.markStatementPaid);
router.get('/commissions',          requireAdmin, c.listCommissions);
router.post('/commissions/:id/reverse', requireAdmin, c.reverseCommission);

module.exports = router;
