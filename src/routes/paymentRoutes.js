const express = require('express');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { requireAdmin } = require('../middleware/auth');
const {
  getConfig,
  createOrder,
  startTrial,
  webhook,
  getStatus,
  verifyPayment,
  verifyPaymentPublic,
  getPendingPayments,
  getRevenueSummary,
} = require('../controllers/paymentController');

const router = express.Router();

router.get('/admin/pending', requireAdmin, getPendingPayments);
router.get('/admin/revenue', requireAdmin, getRevenueSummary);

// Public endpoints are authenticated by student_code + PIN inside the
// controller (login is blocked for pending/expired accounts, which is exactly
// when a student needs to pay). Rate-limited to curb abuse.
const payLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many payment requests. Please try again later.',
});

router.get('/config', getConfig);
router.post('/order',  payLimiter, createOrder);
router.post('/trial',  payLimiter, startTrial);
router.post('/status', payLimiter, getStatus);
router.post('/verify',  payLimiter, verifyPayment);
router.post('/verify-public', payLimiter, verifyPaymentPublic);

// NOTE: /webhook is mounted separately in app.js (needs the raw body for
// signature verification) and must NOT go through this JSON router.

module.exports = { router, webhook };
