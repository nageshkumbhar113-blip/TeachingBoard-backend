const crypto = require('crypto');
const User = require('../models/User');
const PinRequest = require('../models/PinRequest');
const HelpConfig = require('../models/HelpConfig');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isWeakPin } = require('../utils/pin');
const { normalizeMobile } = require('./guestController');
const { invalidateUserCache } = require('../middleware/auth');
const { parentTokensFor } = require('../utils/parentTokens');
const { sendToUser } = require('../utils/fcm');

// Help bot on the login page (core/helpBot.js). "Forgot code / PIN" is done by
// the student alone only when name + parent's mobile match AND this phone is the
// one the account is bound to; otherwise a request goes to Admin > 🤖 Help.

const TICKET_MS = 10 * 60 * 1000;
const _clean = (v, max = 60) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const _norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
const _hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// Accounts on this number whose name matches (full name, or the first name when that is unique).
function _byName(list, name) {
  const want = _norm(name);
  if (!want) return [];
  const exact = list.filter(u => _norm(u.name) === want);
  if (exact.length) return exact;
  const first = want.split(' ')[0];
  const firstHits = list.filter(u => _norm(u.name).split(' ')[0] === first);
  return firstHits.length === 1 ? firstHits : [];
}

// POST /api/help/recover { name, mobile, device_id } -> { ok, student_code, name, ticket } | { ok:false }
exports.recover = asyncHandler(async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  const deviceId = _clean(req.body?.device_id, 100);
  const name = _clean(req.body?.name, 60);
  const fail = () => res.json({ ok: false });   // never says which part did not match
  if (!mobile || !name) return fail();
  const students = await User.find({ role: 'student', mobile }).select('user_id name student_code device_id status').lean();
  const named = _byName(students, name).filter(u => u.status !== 'blocked');
  const hits = named.filter(u => u.device_id && u.device_id === deviceId);
  // Name + number are right but the account is on another phone (or on none yet):
  // say so, so the person knows to use that phone or ask the admin.
  if (hits.length !== 1) return res.json({ ok: false, reason: named.length ? 'other_device' : 'no_match' });
  const u = hits[0];
  const ticket = crypto.randomBytes(24).toString('hex');
  await User.updateOne({ user_id: u.user_id }, { $set: { pin_reset_hash: _hash(ticket), pin_reset_expires: new Date(Date.now() + TICKET_MS) } });
  res.json({ ok: true, student_code: u.student_code, name: u.name, ticket });
});

// POST /api/help/reset-pin { student_code, ticket, pin }
exports.resetPin = asyncHandler(async (req, res) => {
  const code = _clean(req.body?.student_code, 30).toUpperCase();
  const ticket = String(req.body?.ticket || '');
  const pin = String(req.body?.pin || '').trim();
  if (!/^\d{4}$/.test(pin) || isWeakPin(pin)) throw new AppError('PIN 4 अंकी आणि अवघड हवा (1234, 1111 असा नको)', 400);
  const u = await User.findOne({ role: 'student', student_code: code }).select('+pin_reset_hash');
  if (!u || !u.pin_reset_hash || !ticket || u.pin_reset_hash !== _hash(ticket) || !u.pin_reset_expires || u.pin_reset_expires < new Date()) {
    throw new AppError('वेळ संपली — पुन्हा "PIN विसरलो" करा', 400);
  }
  u.pin_hash = User.hashPin(pin);
  u.pin_reset_hash = null;
  u.pin_reset_expires = null;
  await u.save();
  invalidateUserCache('student', u.user_id);
  res.json({ ok: true, student_code: u.student_code });
});

// "📱 हे app नवीन phone वर वापरायचं आहे" — done from the OLD phone, right after /help/recover has
// confirmed name + parent's mobile + that this is the bound phone (the ticket proves it).
// The binding is released (the next login binds the new phone), every earlier login stops working,
// the move is logged for the admin and the parents are told. At most MOVE_LIMIT moves in 30 days;
// after that (or when the old phone is lost) it is an admin request as before.
const MOVE_LIMIT = 2;
const MOVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
exports.moveDevice = asyncHandler(async (req, res) => {
  const code = _clean(req.body?.student_code, 30).toUpperCase();
  const ticket = String(req.body?.ticket || '');
  const deviceId = _clean(req.body?.device_id, 100);
  const u = await User.findOne({ role: 'student', student_code: code }).select('+pin_reset_hash');
  if (!u || !u.pin_reset_hash || !ticket || u.pin_reset_hash !== _hash(ticket) || !u.pin_reset_expires || u.pin_reset_expires < new Date()
      || !deviceId || u.device_id !== deviceId) {
    throw new AppError('वेळ संपली — पुन्हा सुरुवातीपासून करा', 400);
  }
  const since = Date.now() - MOVE_WINDOW_MS;
  const recent = (u.device_moves || []).filter(d => new Date(d).getTime() > since);
  if (recent.length >= MOVE_LIMIT) {
    throw new AppError(`30 दिवसांत ${MOVE_LIMIT} वेळाच phone बदलता येतो. आता Admin ला request पाठवा.`, 429);
  }
  const now = new Date();
  u.device_moves = [...recent, now];
  u.moved_from_device = u.device_id;
  u.device_id = null;
  u.device_bound_at = null;
  u.device_token = null;            // the old phone stops getting notifications
  u.tokens_valid_after = now;
  u.pin_reset_hash = null;
  u.pin_reset_expires = null;
  await u.save();
  invalidateUserCache('student', u.user_id);
  await PinRequest.create({
    role: 'student', name: u.name, mobile: u.mobile || '', code: u.student_code, reason: 'device_move',
    note: 'जुन्या phone वरून स्वतः नवीन phone वर shift केलं (help bot)', status: 'done', done_for: u.user_id, done_at: now,
  });
  parentTokensFor([u.student_code])
    .then(tokens => Promise.all(tokens.map(t => sendToUser(t, `${u.name} — नवीन phone`, `${u.name} चं account नवीन phone वर shift झालं. तुम्ही केलं नसेल तर Admin ला कळवा.`, { student_code: u.student_code }).catch(() => {}))))
    .catch(() => {});
  res.json({ ok: true, student_code: u.student_code, moves_left: MOVE_LIMIT - u.device_moves.length });
});

// POST /api/help/pin-request { role, name, mobile, code?, note?, reason? } — for the admin.
exports.pinRequest = asyncHandler(async (req, res) => {
  const role = ['student', 'teacher', 'shop'].includes(req.body?.role) ? req.body.role : 'student';
  const mobile = normalizeMobile(req.body?.mobile);
  const name = _clean(req.body?.name, 60);
  if (!mobile) throw new AppError('योग्य 10 अंकी mobile नंबर लिहा', 400);
  if (!name) throw new AppError('नाव लिहा', 400);
  const q = role === 'student' ? { role: 'student', mobile } : { role: 'teacher', mobile, ...(role === 'shop' ? { partner_type: 'shop' } : { partner_type: { $ne: 'shop' } }) };
  const users = await User.find(q).select('user_id name student_code teacher_code institute_name partner_type assigned_batches').lean();
  const candidates = users.map(u => ({
    user_id: u.user_id, name: u.partner_type === 'shop' ? (u.institute_name || u.name) : u.name,
    code: u.student_code || u.teacher_code || '', role, class: (u.assigned_batches || [])[0] || '',
  }));
  const fields = { role, name, mobile, code: _clean(req.body?.code, 30).toUpperCase(), note: _clean(req.body?.note, 200), reason: _clean(req.body?.reason, 30), candidates };
  // one open request per number and role (asking again just refreshes it)
  const existing = await PinRequest.findOne({ mobile, role, status: 'open' });
  if (existing) { Object.assign(existing, fields); existing.updated_at = new Date(); await existing.save(); }
  else await PinRequest.create(fields);
  res.json({ ok: true });
});

// ── FAQ (admin's own version) + how often answers are used ────────────────
let _faqCache = null, _faqAt = 0;
exports.faq = asyncHandler(async (_req, res) => {
  if (!_faqCache || Date.now() - _faqAt > 5 * 60 * 1000) {
    const c = await HelpConfig.findOne({ key: 'main' }, 'faq updated_at').lean();
    _faqCache = { faq: c?.faq || null, updated_at: c?.updated_at || null };
    _faqAt = Date.now();
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, ..._faqCache });
});

// POST /api/help/hit { id, unresolved? }
exports.hit = asyncHandler(async (req, res) => {
  const id = String(req.body?.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  if (!id) return res.json({ ok: false });
  const inc = { [`stats.${id}.asked`]: req.body?.unresolved ? 0 : 1, [`stats.${id}.unresolved`]: req.body?.unresolved ? 1 : 0 };
  await HelpConfig.updateOne({ key: 'main' }, { $inc: inc }, { upsert: true });
  res.json({ ok: true });
});

// ── Admin ───────────────────────────────────────────────────────────────
exports.adminFaqSave = asyncHandler(async (req, res) => {
  const faq = req.body?.faq ?? null;
  if (faq !== null && (!Array.isArray(faq) || faq.length > 20 || JSON.stringify(faq).length > 60000)) throw new AppError('FAQ चुकीचं आहे', 400);
  await HelpConfig.updateOne({ key: 'main' }, { $set: { faq, updated_at: new Date() } }, { upsert: true });
  _faqCache = null;
  res.json({ success: true });
});

exports.adminOverview = asyncHandler(async (req, res) => {
  const status = ['open', 'done', 'rejected'].includes(req.query.status) ? req.query.status : 'open';
  const [requests, open, cfg] = await Promise.all([
    PinRequest.find({ status }).sort({ updated_at: -1 }).limit(200).lean(),
    PinRequest.countDocuments({ status: 'open' }),
    HelpConfig.findOne({ key: 'main' }).lean(),
  ]);
  res.json({ success: true, data: { requests, open, faq: cfg?.faq || null, stats: cfg?.stats || {} } });
});

function _newPin() {
  let pin;
  do { pin = String(crypto.randomInt(1000, 10000)); } while (isWeakPin(pin));
  return pin;
}

// POST /api/help/admin/pin-requests/:id/resolve { user_id, reset_device } -> { pin, code, name, mobile }
exports.adminResolve = asyncHandler(async (req, res) => {
  const r = await PinRequest.findById(req.params.id);
  if (!r) throw new AppError('Request सापडली नाही', 404);
  const userId = String(req.body?.user_id || '');
  if (!r.candidates.some(c => c.user_id === userId)) throw new AppError('हे account या नंबरचं नाही', 400);
  const u = await User.findOne({ user_id: userId });
  if (!u) throw new AppError('Account सापडलं नाही', 404);
  const pin = _newPin();
  u.pin_hash = User.hashPin(pin);
  if (u.role === 'student' && req.body?.reset_device !== false) { u.device_id = null; u.device_bound_at = null; u.moved_from_device = null; }
  await u.save();
  invalidateUserCache(u.role, u.user_id);
  r.status = 'done'; r.done_for = userId; r.done_at = new Date();
  await r.save();
  res.json({ success: true, data: { pin, code: u.student_code || u.teacher_code || '', name: u.partner_type === 'shop' ? (u.institute_name || u.name) : u.name, mobile: r.mobile, role: r.role } });
});

exports.adminReject = asyncHandler(async (req, res) => {
  await PinRequest.updateOne({ _id: req.params.id }, { $set: { status: 'rejected', done_at: new Date() } });
  res.json({ success: true });
});
