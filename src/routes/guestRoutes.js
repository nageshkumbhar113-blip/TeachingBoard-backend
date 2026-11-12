const express = require('express');
const c = require('../controllers/guestController');
const B = require('../controllers/botController');
const { attachUserIfPresent, requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// New guest sessions per IP — a whole class on one school Wi-Fi must fit.
const sessionLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120, message: 'Too many requests — please try again later' });
const writeLimiter   = createRateLimiter({ windowMs: 60 * 1000, max: 60, message: 'Too many requests — please try again later' });

router.get('/batches', c.listBatches);
router.post('/session', sessionLimiter, attachUserIfPresent, c.createSession);
router.post('/event',   writeLimiter, attachUserIfPresent, c.requireGuest, c.recordEvent);
router.post('/contact', writeLimiter, attachUserIfPresent, c.requireGuest, c.saveContact);
router.post('/device-token', writeLimiter, attachUserIfPresent, c.requireGuest, c.saveDeviceToken);
router.post('/offer',   writeLimiter, attachUserIfPresent, c.requireGuest, c.claimOffer);
router.get('/public/:gid', writeLimiter, c.publicSummary);
router.post('/checkout', writeLimiter, attachUserIfPresent, c.checkout);
router.get('/rank/:quizId', attachUserIfPresent, c.requireGuest, c.getRank);

router.get('/exams', c.nextExam);
router.get('/admin/exams', requireAdmin, c.adminListExams);
router.post('/admin/exams', requireAdmin, c.adminAddExam);
router.delete('/admin/exams/:id', requireAdmin, c.adminDeleteExam);
router.get('/admin/leads',  requireAdmin, c.adminLeads);
router.post('/admin/lead-pin', requireAdmin, c.adminLeadPin);
router.post('/admin/bot-backfill', requireAdmin, c.adminBotBackfill);
router.post('/admin/leads-add', requireAdmin, c.adminLeadsAdd);
router.get('/admin/mt-list', requireAdmin, c.adminMtList);
router.post('/admin/lead-paid', requireAdmin, c.adminLeadPaid);
router.post('/admin/mt-reminded', requireAdmin, c.adminMtReminded);
// WhatsApp bot (Cloudflare Worker, wa-worker/): the child's facts, its requests, and Admin › CRM's token
router.get('/bot-config', B.config);
router.post('/bot/wa-login', B.requireBotKey, B.waLogin);
router.get('/bot/lead/:gid', B.requireBotKey, B.lead);
router.post('/bot/action', B.requireBotKey, B.action);
router.get('/admin/bot-token', requireAdmin, B.adminToken);
router.get('/admin/funnel', requireAdmin, c.adminFunnel);
router.get('/admin/ad-content', requireAdmin, c.adminAdContent);
router.get('/admin/meta', requireAdmin, c.adminMeta);
router.post('/admin/meta/upload', requireAdmin, c.adminMetaUpload);
router.post('/admin/meta/ad', requireAdmin, c.adminMetaCreateAd);
router.post('/admin/meta/action', requireAdmin, c.adminMetaAction);
router.get('/admin/google', requireAdmin, c.adminGoogle);
router.post('/admin/google/action', requireAdmin, c.adminGoogleAction);
router.post('/admin/google/topup', requireAdmin, c.adminGoogleTopup);
router.get('/admin/ad-scripts', requireAdmin, c.adminAdScripts);
router.post('/admin/ad-scripts', requireAdmin, c.adminAdScriptSave);
router.delete('/admin/ad-scripts/:sid', requireAdmin, c.adminAdScriptDelete);
router.delete('/admin/google/topup/:i', requireAdmin, c.adminGoogleTopupDelete);

module.exports = router;
