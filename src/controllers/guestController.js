const { randomBytes } = require('crypto');
const Batch = require('../models/Batch');
const Attempt = require('../models/Attempt');
const GuestLead = require('../models/GuestLead');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { createGuestToken } = require('../utils/token');
const { rankOnTest } = require('../utils/testRank');
const { randomUUID } = require('crypto');
const User = require('../models/User');
const StudentSubscription = require('../models/StudentSubscription');
const razorpay = require('../utils/razorpay');
const { isWeakPin } = require('../utils/pin');

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
  let lead = req.user?.guest ? await GuestLead.findOne({ gid: _gidOf(req) }) : null;
  // App installed from the website ("continue in the app"): the Play referrer
  // carries the visitor's id, so the same lead (and their tests) continues.
  // A lead that already became an account cannot be resumed this way.
  const resumeGid = String(req.body?.resume_gid || '').trim().toUpperCase();
  if (!lead && /^[0-9A-F]{10}$/.test(resumeGid)) {
    lead = await GuestLead.findOne({ gid: resumeGid, converted_code: '' });
    if (!lead) throw new AppError('Guest session not found', 404);
  }

  const batchName = _clean(req.body?.batch, 120) || lead?.batch || '';
  const batch = batchName ? await Batch.findOne({ name: batchName, is_active: { $ne: false } }, 'name').lean() : null;
  if (!batch) throw new AppError('Please choose a valid class', 400);

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

// POST /api/guest/device-token { device_token } — app only, for the evening reminder.
exports.saveDeviceToken = asyncHandler(async (req, res) => {
  const token = String(req.body?.device_token || '').trim().slice(0, 400);
  if (!token) throw new AppError('device_token is required', 400);
  await GuestLead.updateOne({ gid: _gidOf(req) }, { $set: { device_token: token } });
  res.json({ success: true });
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

function _offerActive(lead) {
  return !!(lead?.offer?.expires_at && new Date(lead.offer.expires_at).getTime() > Date.now());
}

async function _leadByTokenOrGid(req) {
  const gid = req.user?.guest ? _gidOf(req) : String(req.body?.gid || req.params?.gid || '').trim().toUpperCase();
  if (!/^[0-9A-F]{10}$/.test(gid)) throw new AppError('Link अपूर्ण आहे', 404);
  const lead = await GuestLead.findOne({ gid });
  if (!lead) throw new AppError('Link अपूर्ण आहे', 404);
  return lead;
}

// GET /api/guest/public/:gid — the parent's pay page (opened from the child's
// WhatsApp message, on the parent's phone, so no token): child's first name,
// latest result, the offer and the prices. Nothing else about the child.
exports.publicSummary = asyncHandler(async (req, res) => {
  const lead = await _leadByTokenOrGid(req);
  const batch = lead.batch ? await Batch.findOne({ name: lead.batch }, 'name monthly_price yearly_price').lean() : null;
  const paid = lead.converted_code ? (await _paidCodes([lead.converted_code])).has(lead.converted_code) : false;
  const students = await _studentCount();
  res.json({
    success: true,
    data: {
      name: lead.name,
      batch: lead.batch,
      tests: lead.tests,
      best_pct: lead.best_pct,
      last_test: lead.last_test,
      parent_mobile_known: !!lead.parent_mobile,
      converted: !!lead.converted_code,
      // The code is useless without the PIN the parent chose; the app needs it
      // to log in once the payment (done in the browser) is through.
      student_code: lead.converted_code || '',
      paid,
      offer: _offerView(lead),
      prices: { monthly: batch?.monthly_price || 0, yearly: batch?.yearly_price || 0 },
      // Real social proof for the pay page: registered students, rounded down.
      students_count: students,
    },
  });
});

let _countCache = { at: 0, n: 0 };
async function _studentCount() {
  if (Date.now() - _countCache.at < 10 * 60 * 1000) return _countCache.n;
  const n = await User.countDocuments({ role: 'student' }).catch(() => 0);
  _countCache = { at: Date.now(), n: n >= 10 ? Math.floor(n / 10) * 10 : n };
  return _countCache.n;
}

// POST /api/guest/checkout { gid?, name, parent_mobile, pin, period }
// Creates the student account (free tier until the payment clears), moves the
// guest's tests into it, and opens a Razorpay order. The first-month offer
// (50 %, while its 12 hours last) applies to a monthly plan only. Payment is
// then verified by the existing /payment/verify(-public) endpoints.
exports.checkout = asyncHandler(async (req, res) => {
  const lead = await _leadByTokenOrGid(req);
  const period = String(req.body?.period || '').trim();
  if (!['monthly', 'yearly'].includes(period)) throw new AppError('Plan निवडा', 400);
  const pin = String(req.body?.pin || '').trim();
  if (!/^\d{4}$/.test(pin)) throw new AppError('PIN 4 अंकी असावा', 400);

  let student;
  if (lead.converted_code) {
    // Second try (closed the payment window, other plan…): same account.
    student = await User.findOne({ role: 'student', student_code: lead.converted_code });
    if (!student || !student.verifyPin(pin)) {
      throw new AppError(`हे account आधीच तयार आहे (Code ${lead.converted_code}). त्याचाच PIN टाका.`, 403);
    }
  } else {
    const name = _clean(req.body?.name || lead.name, 40);
    if (!name) throw new AppError('विद्यार्थ्याचं नाव लिहा', 400);
    if (isWeakPin(pin)) throw new AppError('PIN सोपा आहे — 1234, 1111 असा नको', 400);
    const mobile = normalizeMobile(req.body?.parent_mobile || lead.parent_mobile);
    if (!mobile) throw new AppError('पालकांचा योग्य 10 अंकी mobile नंबर द्या', 400);
    const batch = await Batch.findOne({ name: lead.batch, is_active: { $ne: false } }, 'name').lean();
    if (!batch) throw new AppError('हा class आता उपलब्ध नाही', 400);

    // Same child already registered on this number → use that account instead.
    const sameMobile = await User.find({ role: 'student', mobile }).select('name student_code').lean();
    const dupe = sameMobile.find(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dupe) throw new AppError(`${name} आधीच registered आहे (Code ${dupe.student_code}). App मध्ये त्या code ने login करून pay करा.`, 409);

    let teacherCode = '';
    if (lead.source === 'teacher' && lead.ref) {
      const t = await User.findOne({ role: 'teacher', teacher_code: lead.ref }).select('teacher_code').lean();
      if (t) teacherCode = t.teacher_code;
    }

    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'STU';
    let code, tries = 0;
    do {
      code = prefix + String(Math.floor(100 + Math.random() * 900));
      tries++;
    } while (tries < 10 && await User.exists({ student_code: code }));

    student = await User.create({
      user_id: `student-${randomUUID()}`,
      name,
      role: 'student',
      student_code: code,
      mobile,
      status: 'active',
      free_tier: true,
      assigned_batches: [batch.name],
      approved_at: new Date(),
      approved_by: 'auto',
      request_source: 'self',
      referred_by_teacher: teacherCode,
      pin_hash: User.hashPin(pin),
    });
    if (teacherCode) await User.updateOne({ role: 'teacher', teacher_code: teacherCode }, { $addToSet: { assigned_students: code } });

    // Everything done as a guest now belongs to the account.
    await Attempt.updateMany({ student_code: `GUEST-${lead.gid}` }, { $set: { student_code: code, student_name: name } });
    lead.converted_code = code;
    lead.converted_at = new Date();
    if (!lead.parent_mobile) lead.parent_mobile = mobile;
  }

  const batchDoc = await Batch.findOne({ name: student.assigned_batches[0] || lead.batch });
  if (!batchDoc) throw new AppError('Batch not found', 404);
  const price = period === 'yearly' ? batchDoc.yearly_price : batchDoc.monthly_price;
  if (!price || price <= 0) throw new AppError(`या class ची ${period === 'yearly' ? 'yearly' : 'monthly'} किंमत अजून ठरलेली नाही`, 400);

  const priorPaid = await StudentSubscription.exists({ student_user_id: student.user_id, payment_verified: true, is_trial: false });
  const useOffer = period === 'monthly' && _offerActive(lead) && !priorPaid;
  const percent = useOffer ? (lead.offer.percent || OFFER_PERCENT) : 0;
  const amount = Math.round(price * (1 - percent / 100));

  if (!lead.steps.includes('checkout')) lead.steps.push('checkout');
  lead.last_seen_at = new Date();
  await lead.save();

  const order = await razorpay.createOrder({
    amount: amount * 100,
    currency: 'INR',
    receipt: `tb_${student.student_code}_${Date.now()}`,
    notes: { student_code: student.student_code, student_user_id: student.user_id, batch: batchDoc.name, period, source: 'guest' },
  });
  await StudentSubscription.create({
    student_user_id: student.user_id,
    student_code: student.student_code,
    batch: batchDoc.name,
    period,
    amount,
    currency: 'INR',
    razorpay_order_id: order.id,
    status: 'created',
    is_trial: false,
    discount_applied_percent: percent,
    discount_source: useOffer ? 'test_offer' : '',
  });

  res.status(201).json({
    success: true,
    student_code: student.student_code,
    name: student.name,
    order_id: order.id,
    amount: order.amount,
    currency: order.currency || 'INR',
    key_id: razorpay.getKeyId(),
    batch: batchDoc.name,
    period,
    original_price: price,
    discount_percent: percent,
  });
});

// ── Admin ────────────────────────────────────────────────────────────────────

const FUNNEL_STEPS = ['opened', 'browsed', 'engaged', 'tested', 'shared_friend', 'shared_parent', 'lead', 'offer_seen', 'checkout', 'paid'];

async function _paidCodes(codes) {
  if (!codes.length) return new Set();
  const paid = await StudentSubscription.distinct('student_code', { student_code: { $in: codes }, payment_verified: true, is_trial: false });
  return new Set(paid);
}

// GET /api/guest/admin/leads?status=all|unpaid|paid|with_mobile&days=30
exports.adminLeads = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const status = String(req.query.status || 'all');
  const filter = { created_at: { $gte: new Date(Date.now() - days * 864e5) } };
  if (status === 'with_mobile') filter.parent_mobile = { $ne: '' };
  const leads = await GuestLead.find(filter).sort({ last_seen_at: -1 }).limit(1000).lean();
  const paid = await _paidCodes(leads.map(l => l.converted_code).filter(Boolean));
  let data = leads.map(l => ({
    gid: l.gid,
    name: l.name,
    batch: l.batch,
    source: l.source,
    ref: l.ref,
    parent_mobile: l.parent_mobile,
    tests: l.tests,
    best_pct: l.best_pct,
    last_test: l.last_test,
    steps: l.steps,
    offer: l.offer?.expires_at ? { expires_at: l.offer.expires_at, active: new Date(l.offer.expires_at) > new Date() } : null,
    student_code: l.converted_code,
    paid: paid.has(l.converted_code),
    created_at: l.created_at,
    last_seen_at: l.last_seen_at,
  }));
  if (status === 'paid') data = data.filter(l => l.paid);
  if (status === 'unpaid') data = data.filter(l => !l.paid);
  res.json({ success: true, count: data.length, data });
});

// GET /api/guest/admin/funnel?days=30 — how many guests reached each step, per source.
exports.adminFunnel = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const leads = await GuestLead.find({ created_at: { $gte: new Date(Date.now() - days * 864e5) } }, 'source steps converted_code').lean();
  const paid = await _paidCodes(leads.map(l => l.converted_code).filter(Boolean));
  const blank = () => Object.fromEntries(FUNNEL_STEPS.map(s => [s, 0]));
  const total = blank();
  const bySource = {};
  for (const l of leads) {
    const steps = new Set(l.steps || []);
    if (paid.has(l.converted_code)) steps.add('paid');
    const src = l.source || 'direct';
    bySource[src] = bySource[src] || blank();
    for (const s of steps) {
      if (s in total) { total[s]++; bySource[src][s]++; }
    }
  }
  res.json({ success: true, days, steps: FUNNEL_STEPS, total, by_source: bySource });
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
