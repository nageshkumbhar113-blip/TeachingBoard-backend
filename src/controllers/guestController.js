const { randomBytes } = require('crypto');
const Batch = require('../models/Batch');
const Attempt = require('../models/Attempt');
const GuestLead = require('../models/GuestLead');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { createGuestToken } = require('../utils/token');
const { rankOnTest } = require('../utils/testRank');

// Free part without login (docs/PLAN_guest_funnel.md). A guest gets a signed
// token for the one batch they picked; middleware/auth.js turns it into a
// free-tier student that can only read free content and submit tests.

const OFFER_PERCENT = 50;
const OFFER_HOURS = 12;
const SOURCES = new Set(['admin', 'friend', 'teacher']);
const EVENT_STEPS = new Set(['browsed', 'engaged', 'shared_friend', 'shared_parent', 'offer_seen', 'checkout']);

const _clean = (v, max = 60) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const _istMonth = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
const _gidOf = req => String(req.user?.id || '').replace(/^guest:/, '');

function _newGid() {
  return randomBytes(5).toString('hex').toUpperCase();   // GUEST-XXXXXXXXXX
}

// 10-digit Indian mobile from whatever the phone / contacts gave us
// ("+91 98…", "098…", spaces, dashes). '' when it is not a plausible number.
function normalizeMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return '';
  if (/^(\d)\1{9}$/.test(d)) return '';                         // 9999999999
  if (['6789012345', '9876543210', '7894561230'].includes(d)) return '';
  return d;
}

function _profile(lead) {
  return {
    guest: true,
    gid: lead.gid,
    name: lead.name,
    student_code: `GUEST-${lead.gid}`,
    assigned_batches: lead.batch ? [lead.batch] : [],
    access_level: 'free',
    has_parent_mobile: !!lead.parent_mobile,
  };
}

function _offerView(lead) {
  const o = lead?.offer;
  if (!o || !o.expires_at) return null;
  return {
    percent: o.percent,
    expires_at: o.expires_at,
    active: new Date(o.expires_at).getTime() > Date.now(),
    month: o.month,
  };
}

async function _lead(req) {
  const gid = _gidOf(req);
  const lead = gid ? await GuestLead.findOne({ gid }) : null;
  if (!lead) throw new AppError('Guest session not found', 401);
  return lead;
}

// The guest endpoints (other than batches / session) need a guest token.
function requireGuest(req, res, next) {
  if (!req.user?.guest) return res.status(401).json({ success: false, message: 'Guest session required' });
  next();
}

// GET /api/guest/batches — the batch picker (no token needed).
exports.listBatches = asyncHandler(async (_req, res) => {
  const batches = await Batch.find({ is_active: { $ne: false } }, 'name icon cover_image board medium standard subjects.name').lean();
  res.json({
    success: true,
    data: batches.map(b => ({
      name: b.name,
      icon: b.icon || '📚',
      cover_image: b.cover_image || '',
      board: b.board || '',
      medium: b.medium || '',
      standard: b.standard || '',
      subjects: (b.subjects || []).map(s => s.name),
    })),
  });
});

// POST /api/guest/session { batch, name?, src?, ref? }
// New guest, or (with a guest token) the same guest choosing another batch /
// giving their name. Returns a fresh token for that batch.
exports.createSession = asyncHandler(async (req, res) => {
  const batchName = _clean(req.body?.batch, 120);
  const batch = batchName ? await Batch.findOne({ name: batchName, is_active: { $ne: false } }, 'name').lean() : null;
  if (!batch) throw new AppError('Please choose a valid class', 400);

  let lead = req.user?.guest ? await GuestLead.findOne({ gid: _gidOf(req) }) : null;
  if (!lead) {
    const src = _clean(req.body?.src, 20);
    lead = new GuestLead({
      gid: _newGid(),
      source: SOURCES.has(src) ? src : '',
      ref: _clean(req.body?.ref, 40).toUpperCase(),
      steps: ['opened'],
    });
  }
  lead.batch = batch.name;
  const name = _clean(req.body?.name, 40);
  if (name) lead.name = name;
  lead.last_seen_at = new Date();
  await lead.save();

  res.status(201).json({
    success: true,
    token: createGuestToken({ gid: lead.gid, name: lead.name, batch: lead.batch }),
    profile: _profile(lead),
    offer: _offerView(lead),
  });
});

// POST /api/guest/event { step } — funnel step reached (each counted once per guest).
exports.recordEvent = asyncHandler(async (req, res) => {
  const step = _clean(req.body?.step, 30);
  if (!EVENT_STEPS.has(step)) throw new AppError('Unknown step', 400);
  await GuestLead.updateOne({ gid: _gidOf(req) }, { $addToSet: { steps: step }, $set: { last_seen_at: new Date() } });
  res.json({ success: true });
});

// POST /api/guest/contact { parent_mobile, consent: true }
exports.saveContact = asyncHandler(async (req, res) => {
  const mobile = normalizeMobile(req.body?.parent_mobile);
  if (!mobile) throw new AppError('कृपया योग्य 10 अंकी mobile नंबर द्या', 400);
  if (req.body?.consent !== true) throw new AppError('पालकांची संमती आवश्यक आहे', 400);
  const lead = await _lead(req);
  lead.parent_mobile = mobile;
  lead.consent_at = new Date();
  if (!lead.steps.includes('lead')) lead.steps.push('lead');
  lead.last_seen_at = new Date();
  await lead.save();
  res.json({ success: true, profile: _profile(lead) });
});

// GET /api/guest/rank/:quizId — live rank of this guest on a test.
exports.getRank = asyncHandler(async (req, res) => {
  const quizId = _clean(req.params.quizId, 80);
  if (!quizId) throw new AppError('quizId is required', 400);
  res.json({ success: true, data: await rankOnTest(quizId, req.user.student_code) });
});

// POST /api/guest/offer — after finishing a test: 50 % off the first month,
// 12 hours, at most once per calendar month (per guest, and per parent mobile).
// Repeated calls return the same offer (active or expired) — never a new one.
exports.claimOffer = asyncHandler(async (req, res) => {
  const lead = await _lead(req);
  const month = _istMonth();
  if (lead.offer?.month === month) return res.json({ success: true, offer: _offerView(lead) });

  const tested = await Attempt.exists({ student_code: req.user.student_code });
  if (!tested) throw new AppError('Finish a test first', 400);

  if (lead.parent_mobile) {
    const other = await GuestLead.findOne({ parent_mobile: lead.parent_mobile, 'offer.month': month, gid: { $ne: lead.gid } }).lean();
    if (other) {
      lead.offer = other.offer;
      await lead.save();
      return res.json({ success: true, offer: _offerView(lead) });
    }
  }

  const now = new Date();
  lead.offer = { percent: OFFER_PERCENT, issued_at: now, expires_at: new Date(now.getTime() + OFFER_HOURS * 3600 * 1000), month };
  await lead.save();
  res.json({ success: true, offer: _offerView(lead) });
});

// Called by attemptController after a guest's test is saved.
async function noteGuestAttempt(studentCode, quizTitle, pct) {
  const gid = String(studentCode || '').replace(/^GUEST-/, '');
  if (!gid) return;
  await GuestLead.updateOne({ gid }, {
    $inc: { tests: 1 },
    $max: { best_pct: Math.round(pct) },
    $addToSet: { steps: 'tested' },
    $set: { last_test: String(quizTitle || '').slice(0, 120), last_seen_at: new Date() },
  });
}

exports.requireGuest = requireGuest;
exports.normalizeMobile = normalizeMobile;
exports.noteGuestAttempt = noteGuestAttempt;
