// 👥 Team (sub-admins) for the "NKs Team" app: the admin makes members (name, mobile, PIN); a member logs in with
// mobile + PIN and may use only the CRM (parents) — never money, content, students' full access or settings.
const crypto = require('crypto');
const TeamMember = require('../models/TeamMember');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { decodeTokenFromHeader, signStaffToken } = require('../utils/token');
const { isWeakPin } = require('../utils/pin');

const mobileOf = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return /^[6-9]\d{9}$/.test(d) ? d : ''; };
const pinHash = pin => User.hashPin(String(pin));
const pinOk = (m, pin) => { const a = Buffer.from(m.pin_hash || ''), b = Buffer.from(pinHash(pin)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const view = m => ({ id: m.member_id, name: m.name, mobile: m.mobile, active: m.active !== false, last_login_at: m.last_login_at, created_at: m.created_at });

// the admin, or an active team member (req.staff = { id, name }); a member's old token stops after a PIN change / switch-off
const _cache = new Map();
async function requireAdminOrStaff(req, res, next) {
  const p = decodeTokenFromHeader(req.headers.authorization);
  if (!p) return res.status(401).json({ success: false, message: 'Login करा' });
  if (p.role === 'admin') { req.user = p; return next(); }
  if (p.role !== 'staff') return res.status(403).json({ success: false, message: 'Admin / team login हवा' });
  let hit = _cache.get(p.id);
  if (!hit || Date.now() - hit.at > 60e3) { hit = { at: Date.now(), m: await TeamMember.findOne({ member_id: p.id }).lean() }; _cache.set(p.id, hit); }
  const m = hit.m;
  if (!m || m.active === false) return res.status(401).json({ success: false, code: 'TEAM_OFF', message: 'तुमचं team account बंद आहे — Admin ला विचारा' });
  if (m.tokens_valid_after && (p.iat || 0) * 1000 < new Date(m.tokens_valid_after).getTime()) return res.status(401).json({ success: false, code: 'TEAM_RELOGIN', message: 'पुन्हा login करा' });
  req.user = p; req.staff = { id: m.member_id, name: m.name };
  next();
}
const forget = id => _cache.delete(id);

// POST /api/team/login { mobile, pin }
exports.login = asyncHandler(async (req, res) => {
  const mobile = mobileOf(req.body?.mobile), pin = String(req.body?.pin || '').trim();
  if (!mobile || !/^\d{4}$/.test(pin)) throw new AppError('Mobile आणि 4 अंकी PIN टाका', 400);
  const m = await TeamMember.findOne({ mobile });
  if (!m || !pinOk(m, pin)) throw new AppError('Mobile किंवा PIN चुकीचा', 401);
  if (m.active === false) throw new AppError('तुमचं team account बंद आहे — Admin ला विचारा', 403);
  m.last_login_at = new Date(); await m.save();
  res.json({ success: true, token: signStaffToken({ id: m.member_id, name: m.name }), member: view(m) });
});

// GET /api/team/me
exports.me = asyncHandler(async (req, res) => {
  if (!req.staff) return res.json({ success: true, data: { admin: true, name: 'Admin' } });
  res.json({ success: true, data: { id: req.staff.id, name: req.staff.name } });
});

// ── Admin › Settings › 👥 Team ──
exports.list = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: (await TeamMember.find().sort({ created_at: 1 }).lean()).map(view) });
});
exports.create = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40), mobile = mobileOf(req.body?.mobile), pin = String(req.body?.pin || '').trim();
  if (name.length < 2) throw new AppError('नाव लिहा', 400);
  if (!mobile) throw new AppError('योग्य 10 अंकी mobile', 400);
  if (!/^\d{4}$/.test(pin) || isWeakPin(pin)) throw new AppError('4 अंकी PIN (1234, 1111 असा सोपा नको)', 400);
  if (await TeamMember.exists({ mobile })) throw new AppError('हा mobile आधीच team मध्ये आहे', 409);
  const m = await TeamMember.create({ member_id: 'TM' + crypto.randomBytes(4).toString('hex').toUpperCase(), name, mobile, pin_hash: pinHash(pin) });
  res.status(201).json({ success: true, data: view(m) });
});
exports.update = asyncHandler(async (req, res) => {
  const m = await TeamMember.findOne({ member_id: String(req.params.id || '') });
  if (!m) throw new AppError('Team member सापडला नाही', 404);
  const b = req.body || {};
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (n.length < 2) throw new AppError('नाव लिहा', 400); m.name = n; }
  if (b.pin !== undefined) {
    const pin = String(b.pin).trim();
    if (!/^\d{4}$/.test(pin) || isWeakPin(pin)) throw new AppError('4 अंकी PIN (सोपा नको)', 400);
    m.pin_hash = pinHash(pin); m.tokens_valid_after = new Date();
  }
  if (b.active !== undefined) { m.active = !!b.active; if (!m.active) m.tokens_valid_after = new Date(); }
  await m.save(); forget(m.member_id);
  res.json({ success: true, data: view(m) });
});
exports.remove = asyncHandler(async (req, res) => {
  const r = await TeamMember.deleteOne({ member_id: String(req.params.id || '') });
  forget(String(req.params.id || ''));
  res.json({ success: true, data: { deleted: r.deletedCount || 0 } });
});

exports.requireAdminOrStaff = requireAdminOrStaff;
