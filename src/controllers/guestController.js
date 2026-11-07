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
const Quiz = require('../models/Quiz');
const { isQuizLocked } = require('../utils/contentAccess');
const CommissionEntry = require('../models/CommissionEntry');
const Note = require('../models/Note');
const META = require('../utils/meta');
const GADS = require('../utils/googleAds');
const SLSQuestion = require('../models/SLSQuestion');
const { isChapterIdFree, makeChapterId } = require('../utils/contentAccess');

// Free part without login (docs/PLAN_guest_funnel.md). A guest gets a signed
// token for the one batch they picked; middleware/auth.js turns it into a
// free-tier student that can only read free content and submit tests.

const OFFER_PERCENT = 50;
const OFFER_HOURS = 12;
// 'ad' = a Facebook / Instagram ad's link (ref = the ad's id, Admin › Sync › Ads)
const SOURCES = new Set(['admin', 'friend', 'teacher', 'student', 'shop', 'ad', 'web']);
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

// How many published tests of each class a free visitor can open (cached 5 min) — for
// Admin's per-class free-link message ("✅ 12 Free Tests").
let _freeCount = null, _freeCountAt = 0;
async function _freeTestCounts() {
  if (_freeCount && Date.now() - _freeCountAt < 5 * 60 * 1000) return _freeCount;
  const visitor = { role: 'student', status: 'active', free_tier: true, expiry_date: null };
  const quizzes = await Quiz.find({ status: 'published' }, 'batch subject chapter paper_mode sections.source_batch sections.subject sections.chapter').lean();
  const out = {};
  for (const q of quizzes) if (!(await isQuizLocked(visitor, q))) out[q.batch] = (out[q.batch] || 0) + 1;
  _freeCount = out; _freeCountAt = Date.now();
  return out;
}

// GET /api/guest/batches — the batch picker (no token needed).
exports.listBatches = asyncHandler(async (_req, res) => {
  const batches = await Batch.find({ is_active: { $ne: false } }, 'name icon cover_image board medium standard subjects.name').lean();
  const free = await _freeTestCounts().catch(() => ({}));
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
      free_tests: free[b.name] || 0,
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
    let src = _clean(req.body?.src, 20);
    // the Free Test button on our own exam pages (&ad=web-<exam>) is not an ad: its own source
    if (src === 'ad' && /^web-/i.test(String(req.body?.ref || ''))) src = 'web';
    lead = new GuestLead({
      gid: _newGid(),
      source: SOURCES.has(src) ? src : '',
      ref: src === 'ad' || src === 'web' ? _clean(req.body?.ref, 40).toLowerCase().replace(/[^a-z0-9-]/g, '') : _clean(req.body?.ref, 40).toUpperCase(),
      link_batch: _clean(req.body?.link_batch, 120) === batch.name ? batch.name : '',
      steps: ['opened'],
      // from a Facebook / Instagram ad link (?src=meta&ad=…&fbclid=…): Meta's click id
      ...(src === 'ad' && req.body?.fbclid ? { fbc: META.fbcOf(req.body.fbclid), ua: String(req.get('user-agent') || '').slice(0, 300) } : {}),
      // from a Google / YouTube ad link (?src=yt&ad=yt-…&gclid=…): Google's click id
      ...(src === 'ad' ? GADS.clickOf(req.body) : {}),
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
  _adLead(lead.gid).catch(err => console.warn('[ad lead] contact', err.message));
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

// POST /api/guest/offer — after finishing a test: 50 % off the FIRST PAYMENT (monthly or yearly),
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
// guest's tests into it, and opens a Razorpay order. The first-payment offer
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
    if ((lead.source === 'teacher' || lead.source === 'shop') && lead.ref) {
      const t = await User.findOne({ role: 'teacher', teacher_code: lead.ref }).select('teacher_code partner_type mobile').lean();
      // a shop's own number never counts for the shop
      if (t && !(t.partner_type === 'shop' && t.mobile === mobile)) teacherCode = t.teacher_code;
    }
    // Came from a student's own share link (?free=1&ref=CODE): that student's
    // Refer & Earn friend — same rule as registration (not the same mobile).
    let friendCode = '';
    if (lead.source === 'student' && lead.ref) {
      const f = await User.findOne({ role: 'student', student_code: lead.ref }).select('student_code mobile').lean();
      if (f && f.mobile !== mobile) friendCode = f.student_code;
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
      referred_by_student: friendCode,
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
  // Owner's choice 2026-11-01: the offer is on the first payment, monthly or yearly.
  const useOffer = _offerActive(lead) && !priorPaid;
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

// ── Exam countdown ───────────────────────────────────────────────────────────
const ExamDate = require('../models/ExamDate');

// GET /api/guest/exams?batch= — the next real exam for that class (or for all).
exports.nextExam = asyncHandler(async (req, res) => {
  const batch = _clean(req.query.batch, 120);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exam = await ExamDate.findOne({ date: { $gte: today }, batch: { $in: ['', batch] } }).sort({ date: 1 }).lean();
  res.json({ success: true, data: exam ? { title: exam.title, date: exam.date, batch: exam.batch } : null });
});

exports.adminListExams = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await ExamDate.find({}).sort({ date: 1 }).lean() });
});

exports.adminAddExam = asyncHandler(async (req, res) => {
  const title = _clean(req.body?.title, 60);
  const date = new Date(req.body?.date);
  if (!title) throw new AppError('परीक्षेचं नाव लिहा', 400);
  if (Number.isNaN(date.getTime())) throw new AppError('तारीख चुकीची आहे', 400);
  const exam = await ExamDate.create({ title, date, batch: _clean(req.body?.batch, 120) });
  res.status(201).json({ success: true, data: exam });
});

exports.adminDeleteExam = asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(String(req.params.id))) throw new AppError('Not found', 404);
  await ExamDate.deleteOne({ _id: req.params.id });
  res.json({ success: true });
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
  const leads = await GuestLead.find({ created_at: { $gte: new Date(Date.now() - days * 864e5) } }, 'source ref steps converted_code link_batch').lean();
  const paid = await _paidCodes(leads.map(l => l.converted_code).filter(Boolean));
  const blank = () => Object.fromEntries(FUNNEL_STEPS.map(s => [s, 0]));
  const total = blank();
  const bySource = {}, byLink = {}, byAd = {};
  for (const l of leads) {
    const steps = new Set(l.steps || []);
    if (paid.has(l.converted_code)) steps.add('paid');
    const src = l.source || 'direct';
    bySource[src] = bySource[src] || blank();
    if (l.link_batch) byLink[l.link_batch] = byLink[l.link_batch] || blank();
    const ad = src === 'ad' && l.ref ? String(l.ref).toLowerCase() : '';
    if (ad) byAd[ad] = byAd[ad] || blank();
    for (const s of steps) {
      if (s in total) { total[s]++; bySource[src][s]++; if (l.link_batch) byLink[l.link_batch][s]++; if (ad) byAd[ad][s]++; }
    }
  }
  // by_link: visitors who came through a per-class link (Admin › Free link › class)
  // by_ad: visitors per Facebook / Instagram ad (Admin › Sync › Ads leaderboard)
  res.json({ success: true, days, steps: FUNNEL_STEPS, total, by_source: bySource, by_link: byLink, by_ad: byAd, by_teacher_ad: await _teacherAds(days) });
});

// Teachers / YouTubers who registered from an ad: registered → approved → students they
// brought → students who paid (a commission entry), per ad.
async function _teacherAds(days) {
  const ts = await User.find({ role: 'teacher', signup_ad: { $nin: ['', null] }, created_at: { $gte: new Date(Date.now() - days * 864e5) } }, 'user_id teacher_code signup_ad status').lean();
  if (!ts.length) return {};
  const codes = ts.map(t => t.teacher_code).filter(Boolean);
  const [studs, paid] = await Promise.all([
    User.aggregate([{ $match: { role: 'student', referred_by_teacher: { $in: codes } } }, { $group: { _id: '$referred_by_teacher', n: { $sum: 1 } } }]),
    CommissionEntry.aggregate([{ $match: { type: 'commission', status: 'active', partner_user_id: { $in: ts.map(t => t.user_id) } } }, { $group: { _id: '$partner_user_id', s: { $addToSet: '$student_code' } } }]),
  ]);
  const sBy = new Map(studs.map(r => [r._id, r.n])), pBy = new Map(paid.map(r => [r._id, r.s.length]));
  const out = {};
  for (const t of ts) {
    const r = out[t.signup_ad] = out[t.signup_ad] || { registered: 0, approved: 0, students: 0, paid: 0 };
    r.registered++;
    if (t.status === 'active') r.approved++;
    r.students += sBy.get(t.teacher_code) || 0;
    r.paid += pBy.get(t.user_id) || 0;
  }
  return out;
}

// GET /api/guest/admin/ad-content?batch=… — what a regular class really has, subject by
// subject, for its Facebook / Instagram ads (Admin › Sync › Ads): chapters, notes, exercise
// answers, how many chapters are fully covered, one real chapter (the free one when it has
// content) and one real exercise question + answer for the demo screens.
exports.adminAdContent = asyncHandler(async (req, res) => {
  const name = _clean(req.query.batch, 120);
  const batch = await Batch.findOne({ name }, 'name subjects').lean();
  if (!batch) throw new AppError('Class not found', 404);
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
  const [notes, ex] = await Promise.all([
    Note.aggregate([{ $match: { batch: batch.name, status: { $ne: 'archived' } } }, { $group: { _id: { s: '$subject', c: '$chapter' }, n: { $sum: 1 }, title: { $first: '$title' } } }]),
    SLSQuestion.aggregate([{ $match: { batchId: batch.name, status: 'published' } }, { $group: { _id: { s: '$subjectId', c: '$chapterId' }, n: { $sum: 1 } } }]),
  ]);
  const subjects = [];
  for (const s of batch.subjects || []) {
    const chapters = (s.chapters || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const nOf = c => notes.filter(r => norm(r._id.s) === norm(s.name) && norm(r._id.c) === norm(c.name));
    const eOf = c => ex.filter(r => norm(r._id.s) === norm(s.name) && r._id.c === makeChapterId(batch.name, s.name, c.name));
    const rows = await Promise.all(chapters.map(async c => ({
      name: c.name,
      notes: nOf(c).reduce((t, r) => t + r.n, 0),
      note_title: nOf(c)[0]?.title || '',
      answers: eOf(c).reduce((t, r) => t + r.n, 0),
      free: await isChapterIdFree(makeChapterId(batch.name, s.name, c.name)).catch(() => false),
    })));
    if (!rows.length) continue;
    // the demo chapter: the free one with notes and answers, else any with both, else any with something
    const pick = rows.find(r => r.free && r.notes && r.answers) || rows.find(r => r.notes && r.answers) || rows.find(r => r.notes || r.answers) || null;
    let sample = null;
    if (pick?.answers) {
      const q = await SLSQuestion.findOne({ batchId: batch.name, chapterId: makeChapterId(batch.name, s.name, pick.name), status: 'published' })
        .sort({ exerciseNo: 1, created_at: 1 }).select('exerciseNo questionText answerText').lean();
      if (q) sample = {
        exercise_no: q.exerciseNo || '',
        question: String(q.questionText?.marathi || q.questionText?.english || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
        answer: String(q.answerText?.marathi || q.answerText?.english || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260),
      };
    }
    subjects.push({
      subject: s.name,
      chapters: rows.length,
      notes: rows.reduce((t, r) => t + r.notes, 0),
      answers: rows.reduce((t, r) => t + r.answers, 0),
      chapters_with_notes: rows.filter(r => r.notes).length,
      chapters_with_answers: rows.filter(r => r.answers).length,
      demo_chapter: pick ? { name: pick.name, note_title: pick.note_title, free: pick.free } : null,
      sample,
    });
  }
  // competitive classes: real questions from the class's free tests, and the exam the class is
  // linked to in Admin › Site / Exams (name, benefit, the ad's loss line, the next date)
  const SITE = require('./siteController');
  const [mcqs, sx] = await Promise.all([SITE.sampleMcqs(batch.name, 12).catch(() => []), SITE.examForBatch(batch.name).catch(() => null)]);
  const today = new Date().setHours(0, 0, 0, 0);
  const next = (sx?.dates || []).filter(d => d.date && new Date(d.date).getTime() >= today).sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  const exam = sx ? { slug: sx.slug, name: sx.name, name_en: sx.name_en, group: sx.group, benefit: sx.benefit, ad_loss_mr: sx.ad_loss_mr, ad_loss_en: sx.ad_loss_en,
    next_date: next ? { label: next.label, date: next.date } : null } : null;
  res.json({ success: true, batch: batch.name, subjects, mcqs, exam });
});

// GET /api/guest/admin/meta?days=30 — Meta (Facebook / Instagram) ads: is it connected, the ad
// account, and each ad's spend / impressions / link clicks keyed by the ad's name (= our ad id).
// Read-only. The token stays on the server; ?check=1 only checks the connection.
exports.adminMeta = asyncHandler(async (req, res) => {
  const cfg = META.configured();
  if (!cfg.ok) return res.json({ success: true, connected: false, config: cfg });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  try {
    if (req.query.fresh === '1') META._resetCache();
    // 📡 just every ad's state right now (one light Meta call, never cached): upload / review / running / why
    if (req.query.status === '1') return res.json({ success: true, connected: true, account_id: String(process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''), ads: await META.adsState(), at: new Date().toISOString() });
    const since = new Date(Date.now() - days * 864e5);
    const [account, ins, leads, paid] = await Promise.all([
      META.account(), req.query.check === '1' ? null : META.insights(days),
      GuestLead.countDocuments({ capi_lead_at: { $gte: since } }), 0,
    ]);
    res.json({ success: true, connected: true, config: { ...cfg, dataset: META.datasetReady() }, account, capi: { leads, paid }, ...(ins || {}) });
  } catch (err) {
    res.json({ success: true, connected: false, config: cfg, error: err.message });
  }
});

// POST /api/guest/admin/meta/upload?kind=video|image&name=… (raw bytes) — the ad's video /
// thumbnail, passed straight on to the Meta ad account (nothing kept on this server).
exports.adminMetaUpload = asyncHandler(async (req, res) => {
  if (!META.configured().ok) throw new AppError('Meta जोडलेलं नाही', 400);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 1000) throw new AppError('File रिकामी आहे', 400);
  const name = _clean(req.query.name, 60).replace(/[^a-z0-9-]/gi, '') || 'eduorbit-ad';
  try {
    const out = req.query.kind === 'image' ? await META.uploadImage(buf) : await META.uploadVideo(buf, name);
    res.json({ success: true, ...out });
  } catch (err) { throw new AppError(err.message, err.status || 400); }
});

// POST /api/guest/admin/meta/action { action: 'pause' | 'resume', ad_id } | { action: 'budget', adset_id }
// — the leaderboard's buttons. Budget: +20% at most per press; never pauses the last running ad of an ad set.
exports.adminMetaAction = asyncHandler(async (req, res) => {
  if (!META.configured().ok) throw new AppError('Meta जोडलेलं नाही', 400);
  const b = req.body || {};
  try {
    let out;
    if (b.action === 'pause' || b.action === 'resume') out = await META.setAdStatus(String(b.ad_id || ''), b.action === 'pause' ? 'PAUSED' : 'ACTIVE');
    else if (b.action === 'budget') out = await META.raiseBudget(String(b.adset_id || ''), 20);
    else if (b.action === 'set_budget') out = await META.setBudget(String(b.adset_id || ''), b.amount, { big: b.big === true });
    else if (b.action === 'replace_video') out = await META.replaceVideo({ ad_id: String(b.ad_id || ''), video_id: String(b.video_id || ''), image_hash: String(b.image_hash || ''), message: String(b.message || '').slice(0, 2000), headline: String(b.headline || '').slice(0, 120), cta: b.cta, link: String(b.link || '').slice(0, 500) });
    else throw new AppError('Unknown action', 400);
    res.json({ success: true, ...out });
  } catch (err) { const e = new AppError(err.message, err.status || 400); if (err.code === 'big') e.details = { big: true }; throw e; }
});

// GET /api/guest/admin/google?days=30 — Google Ads (YouTube ads): connected?, the account, and each
// ad's spend / views / clicks keyed by our ad id (yt-…). The tokens stay on the server.
const AdsConfig = require('../models/AdsConfig');
const GST = 0.18;   // Google India: a prepayment includes 18% GST; the rest is ad money
async function _googleMoney() {
  const c = await AdsConfig.findOne({ key: 'main' }, 'google_topups').lean();
  const topups = (c?.google_topups || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!topups.length) return { topups };
  const paid = topups.reduce((t, x) => t + x.amount, 0), since = topups[0].date;
  const spent = await GADS.spendSince(since);
  return { topups, paid, since, spent, est_balance: Math.round((paid / (1 + GST) - spent) * 100) / 100 };
}

exports.adminGoogle = asyncHandler(async (req, res) => {
  const cfg = GADS.configured();
  if (!cfg.ok) return res.json({ success: true, connected: false, config: cfg });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  try {
    if (req.query.fresh === '1') GADS._resetCache();
    const since = new Date(Date.now() - days * 864e5);
    const [account, ins, leads, money] = await Promise.all([
      GADS.account(), req.query.check === '1' ? null : GADS.insights(days),
      GuestLead.countDocuments({ gads_lead_at: { $gte: since } }),
      _googleMoney().catch(err => ({ error: err.message })),
    ]);
    res.json({ success: true, connected: true, config: cfg, account, leads, money, ...(ins || {}) });
  } catch (err) {
    res.json({ success: true, connected: false, config: cfg, error: err.message });
  }
});

// POST /api/guest/admin/google/topup { amount, date } — money paid into Google Ads (prepay)
// DELETE /api/guest/admin/google/topup/:i — remove a wrong entry
exports.adminGoogleTopup = asyncHandler(async (req, res) => {
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  const date = String(req.body?.date || '');
  if (!(amount >= 1 && amount <= 1000000)) throw new AppError('रक्कम ₹1 ते ₹10,00,000 मध्ये हवी', 400);
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date)) || date > today) throw new AppError('तारीख चुकीची आहे (आजची किंवा मागची हवी)', 400);
  await AdsConfig.updateOne({ key: 'main' }, { $push: { google_topups: { amount, date, at: new Date() } } }, { upsert: true });
  res.json({ success: true });
});
// Admin › Ads › 🎬 माझा video: the saved AI scripts (checked in the browser by adScript.js;
// here only size limits — the text is never run, only parsed as JSON by the admin page)
exports.adminAdScripts = asyncHandler(async (_req, res) => {
  const c = await AdsConfig.findOne({ key: 'main' }, 'video_scripts').lean();
  res.json({ success: true, data: (c?.video_scripts || []).map(v => ({ sid: v.sid, raw: v.raw, at: v.at })) });
});
exports.adminAdScriptSave = asyncHandler(async (req, res) => {
  const raw = String(req.body?.raw || '');
  if (raw.length < 20 || raw.length > 20000) throw new AppError('Script 20 ते 20,000 अक्षरांचा हवा', 400);
  let sid = String(req.body?.sid || '').toLowerCase();
  const c = (await AdsConfig.findOne({ key: 'main' })) || new AdsConfig({ key: 'main' });
  const i = sid ? c.video_scripts.findIndex(v => v.sid === sid) : -1;
  if (i >= 0) { c.video_scripts[i].raw = raw; c.video_scripts[i].at = new Date(); }
  else {
    if (c.video_scripts.length >= 60) throw new AppError('जास्तीत जास्त 60 videos — जुने काढा', 400);
    do { sid = Math.random().toString(36).slice(2, 7); } while (c.video_scripts.some(v => v.sid === sid));
    c.video_scripts.push({ sid, raw, at: new Date() });
  }
  c.markModified('video_scripts');
  await c.save();
  res.json({ success: true, sid });
});
exports.adminAdScriptDelete = asyncHandler(async (req, res) => {
  const sid = String(req.params.sid || '').toLowerCase();
  const r = await AdsConfig.updateOne({ key: 'main' }, { $pull: { video_scripts: { sid } } });
  if (!r.modifiedCount) throw new AppError('Not found', 404);
  res.json({ success: true });
});

exports.adminGoogleTopupDelete = asyncHandler(async (req, res) => {
  const i = parseInt(req.params.i, 10);
  const c = await AdsConfig.findOne({ key: 'main' });
  if (!c || !(i >= 0 && i < c.google_topups.length)) throw new AppError('Not found', 404);
  // the list the admin sees is sorted by date: remove that one
  const sorted = c.google_topups.map((t, k) => ({ t, k })).sort((a, b) => a.t.date.localeCompare(b.t.date));
  c.google_topups.splice(sorted[i].k, 1);
  await c.save();
  res.json({ success: true });
});

// POST /api/guest/admin/google/action { action: 'pause'|'resume', ad } | { action: 'budget', budget }
exports.adminGoogleAction = asyncHandler(async (req, res) => {
  if (!GADS.configured().ok) throw new AppError('Google Ads जोडलेलं नाही', 400);
  const b = req.body || {};
  try {
    let out;
    if (b.action === 'pause' || b.action === 'resume') out = await GADS.setAdStatus(String(b.ad || ''), b.action === 'resume');
    else if (b.action === 'budget') out = await GADS.raiseBudget(String(b.budget || ''));
    else throw new AppError('Unknown action', 400);
    res.json({ success: true, ...out });
  } catch (err) { throw new AppError(err.message, err.status || 400); }
});

// ages for a new ad set: Meta allows 13–65; a pair that makes no sense is ignored
function _ages(min, max) {
  const a = parseInt(min, 10), z = parseInt(max, 10);
  if (!(a >= 13 && z <= 65 && a <= z)) return {};
  return { age_min: a, age_max: z };
}

// POST /api/guest/admin/meta/ad — make the ad (campaign per audience, ad set per class+audience),
// always PAUSED. Re-sending the same ad name does not make a second ad.
exports.adminMetaCreateAd = asyncHandler(async (req, res) => {
  if (!META.configured().ok) throw new AppError('Meta जोडलेलं नाही', 400);
  const b = req.body || {};
  const name = _clean(b.name, 60).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const adset = _clean(b.adset, 80).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const link = String(b.link || '');
  if (!name || !adset) throw new AppError('Ad name missing', 400);
  if (!/^https:\/\/(nkseduorbit\.in|www\.nkseduorbit\.in|teachingboard-frontend\.vercel\.app)\//.test(link)) throw new AppError('Link must be the app link', 400);   // new domain + the old address
  if (!/^\d+$/.test(String(b.video_id || '')) || !b.image_hash) throw new AppError('Video / thumbnail missing', 400);
  try {
    const out = await META.createAd({
      name, adset, audience: String(b.audience || ''), daily_budget: Number(b.daily_budget) || 0,
      video_id: String(b.video_id), image_hash: String(b.image_hash),
      message: String(b.message || '').slice(0, 2000), headline: String(b.headline || '').slice(0, 120),
      cta: b.cta === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE', link,
      geo: ['gata', 'marathwada', 'nashik', 'kolhapur'].includes(b.geo) ? b.geo : 'all',
      ..._ages(b.age_min, b.age_max),
    });
    res.json({ success: true, ...out });
  } catch (err) { throw new AppError(err.message, err.status || 400); }
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
  await _adLead(gid);
}

// A visitor from a parent / teacher ad became a lead → "Lead" to Meta and Google (once each), on
// whichever comes first: the first free test, or the parent's mobile number (a regular-class visitor
// reads notes and may never take a test). Never for student ads (checked before anything is marked).
async function _adLead(gid) {
  const cand = await GuestLead.findOne({ gid, source: 'ad', fbc: { $ne: '' }, capi_lead_at: null }, 'ref').lean();
  const lead = cand && !META.isStudentAd(cand.ref)
    ? await GuestLead.findOneAndUpdate({ gid, capi_lead_at: null }, { $set: { capi_lead_at: new Date() } }, { new: true }).lean() : null;
  if (lead) {
    META.sendEvent({ name: 'Lead', id: `lead-${gid}`, fbc: lead.fbc, ua: lead.ua })
      .catch(err => console.warn('[meta capi] lead', err.message));
  }
  // the same for a Google / YouTube ad: a "Lead" with Google's click id (once; not for student ads)
  if (GADS.leadReady()) {
    const g = await GuestLead.findOne({ gid, source: 'ad', gads_lead_at: null, $or: [{ gclid: { $ne: '' } }, { gbraid: { $ne: '' } }, { wbraid: { $ne: '' } }] }, 'ref gclid gbraid wbraid').lean();
    if (g && !META.isStudentAd(String(g.ref || '').replace(/^yt-/, ''))) {
      const won = await GuestLead.findOneAndUpdate({ gid, gads_lead_at: null }, { $set: { gads_lead_at: new Date() } }, { new: true }).lean();
      if (won) GADS.sendLead(GADS.clickOf(won)).catch(err => console.warn('[google ads] lead', err.message));
    }
  }
}

// "Purchase" (a payment) is NOT sent to Meta — the admin chose Lead only (2026-11-05). Kept for a
// later decision; nothing calls it.
async function noteAdPurchase(sub) {
  if (!META.datasetReady() || !sub?.student_code || sub.is_trial || !(Number(sub.amount) > 0)) return;   // amount in rupees
  const cand = await GuestLead.findOne({ converted_code: sub.student_code, source: 'ad', fbc: { $ne: '' }, capi_paid_at: null }, 'gid ref').lean();
  if (!cand || META.isStudentAd(cand.ref)) return;
  const lead = await GuestLead.findOneAndUpdate({ gid: cand.gid, capi_paid_at: null }, { $set: { capi_paid_at: new Date() } }, { new: true }).lean();
  if (!lead) return;
  await META.sendEvent({ name: 'Purchase', id: `pay-${sub.razorpay_payment_id || sub._id}`, fbc: lead.fbc, ua: lead.ua, value: Number(sub.amount) });
}

exports.requireGuest = requireGuest;
exports.normalizeMobile = normalizeMobile;
exports.noteGuestAttempt = noteGuestAttempt;
exports.noteAdPurchase = (sub) => noteAdPurchase(sub).catch(err => console.warn('[meta capi] purchase', err.message));
