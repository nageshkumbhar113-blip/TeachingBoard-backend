const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const c = require('../controllers/referralController');

const router = express.Router();

// Student: own friend count, prizes, claim
router.get('/me',          requireStudent, c.getMyReferrals);
router.post('/me/claim',   requireStudent, c.claimPrize);

// Admin: prize requests to send
router.get('/claims',      requireAdmin, c.listClaims);
router.get('/summary',     requireAdmin, c.summary);
router.patch('/claims/:id', requireAdmin, c.updateClaim);

module.exports = router;
