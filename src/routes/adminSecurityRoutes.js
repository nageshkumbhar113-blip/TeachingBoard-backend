// 🔐 /api/admin/security — Admin › Settings › 🔐 सुरक्षा: Google Authenticator, the code at login,
// remembered devices, backup codes, the admin PIN, the login log (utils/adminSecurity.js)
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const AdminSecurity = require('../models/AdminSecurity');
const User = require('../models/User');
const S = require('../utils/adminSecurity');
const T = require('../utils/totp');

const router = express.Router();
router.use(requireAdmin);

const view = s => ({
  totp_on: !!s.totp_on,
  enforce: !!s.enforce,
  recovery_left: (s.recovery || []).length,
  devices: (s.devices || []).filter(d => d.expires > new Date()).map(d => ({ id: d.id, name: d.name, created_at: d.created_at, last_used: d.last_used, expires: d.expires })),
  events: (s.events || []).slice(-30).reverse(),
  kill_switch: process.env.ADMIN_2FA_OFF === '1',
});
const needCode = async code => { if (!(await S.checkCode(code))) throw new AppError('Authenticator चा code चुकीचा किंवा जुना', 400); };

router.get('/', asyncHandler(async (_req, res) => res.json({ success: true, data: view(await S.doc()) })));

// 1) a new secret → the QR (otpauth URI) to scan; not active until a code from it is confirmed
router.post('/totp/start', asyncHandler(async (req, res) => {
  const s = await S.doc();
  if (s.totp_on) await needCode(req.body?.code);   // replacing an existing one needs its code
  const secret = T.newSecret();
  await AdminSecurity.updateOne({ key: 'main' }, { $set: { pending_enc: S.seal(secret) } });
  res.json({ success: true, data: { otpauth: T.otpauthUri(secret, 'Admin'), secret } });
}));

// 2) the first code from the app confirms it → on; 10 backup codes, shown this once
router.post('/totp/confirm', asyncHandler(async (req, res) => {
  const s = await S.doc();
  if (!s.pending_enc) throw new AppError('आधी "Authenticator जोडा" दाबा', 400);
  const secret = S.open(s.pending_enc);
  const step = T.matchStep(secret, req.body?.code);
  if (step < 0) throw new AppError('Code जुळला नाही — Authenticator मधला आत्ताचा code टाका', 400);
  const rec = S.newRecovery();
  await AdminSecurity.updateOne({ key: 'main' }, { $set: { totp_enc: S.seal(secret), pending_enc: '', totp_on: true, last_step: step, recovery: rec.hashes } });
  S.log(req, 'authenticator_added');
  res.json({ success: true, data: { recovery: rec.plain, ...view(await S.doc()) } });
}));

// the code at login: on / off (needs a code either way)
router.post('/enforce', asyncHandler(async (req, res) => {
  const s = await S.doc();
  if (!s.totp_on) throw new AppError('आधी Authenticator जोडा', 400);
  await needCode(req.body?.code);
  await AdminSecurity.updateOne({ key: 'main' }, { $set: { enforce: !!req.body?.on } });
  S.log(req, req.body?.on ? 'enforce_on' : 'enforce_off');
  res.json({ success: true, data: view(await S.doc()) });
}));

// remove the authenticator altogether (code needed)
router.post('/totp/remove', asyncHandler(async (req, res) => {
  await needCode(req.body?.code);
  await AdminSecurity.updateOne({ key: 'main' }, { $set: { totp_enc: '', pending_enc: '', totp_on: false, enforce: false, recovery: [], devices: [] } });
  S.log(req, 'authenticator_removed');
  res.json({ success: true, data: view(await S.doc()) });
}));

router.post('/recovery/new', asyncHandler(async (req, res) => {
  await needCode(req.body?.code);
  const rec = S.newRecovery();
  await AdminSecurity.updateOne({ key: 'main' }, { $set: { recovery: rec.hashes } });
  S.log(req, 'backup_codes_new');
  res.json({ success: true, data: { recovery: rec.plain, ...view(await S.doc()) } });
}));

// forget one device, or all of them (a lost laptop): the code is asked there again
router.post('/devices/forget', asyncHandler(async (req, res) => {
  const id = String(req.body?.id || '');
  await AdminSecurity.updateOne({ key: 'main' }, id ? { $pull: { devices: { id } } } : { $set: { devices: [] } });
  S.log(req, id ? 'device_forgotten' : 'all_devices_forgotten');
  res.json({ success: true, data: view(await S.doc()) });
}));

// the admin PIN (6 digits; the current PIN and — when the authenticator is on — a code)
router.post('/pin', asyncHandler(async (req, res) => {
  const current = String(req.body?.current || '').trim(), next = String(req.body?.next || '').trim();
  if (!/^\d{6}$/.test(next) || /^(\d)\1{5}$/.test(next) || '0123456789'.includes(next) || '9876543210'.includes(next)) {
    throw new AppError('नवीन PIN 6 अंकी हवा, आणि सोपा नको (111111, 123456 असा नको)', 400);
  }
  const admin = await User.findOne({ role: 'admin' });
  if (!admin || !admin.verifyPin(current)) throw new AppError('सध्याचा PIN चुकीचा', 400);
  await needCode(req.body?.code);
  admin.pin_hash = User.hashPin(next);
  await admin.save();
  S.log(req, 'pin_changed');
  res.json({ success: true });
}));

module.exports = router;
