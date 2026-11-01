const express = require('express');
const c = require('../controllers/guestController');
const { attachUserIfPresent } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// New guest sessions per IP — a whole class on one school Wi-Fi must fit.
const sessionLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120, message: 'Too many requests — please try again later' });
const writeLimiter   = createRateLimiter({ windowMs: 60 * 1000, max: 60, message: 'Too many requests — please try again later' });

router.get('/batches', c.listBatches);
router.post('/session', sessionLimiter, attachUserIfPresent, c.createSession);
router.post('/event',   writeLimiter, attachUserIfPresent, c.requireGuest, c.recordEvent);
router.post('/contact', writeLimiter, attachUserIfPresent, c.requireGuest, c.saveContact);
router.post('/offer',   writeLimiter, attachUserIfPresent, c.requireGuest, c.claimOffer);
router.get('/rank/:quizId', attachUserIfPresent, c.requireGuest, c.getRank);

module.exports = router;
