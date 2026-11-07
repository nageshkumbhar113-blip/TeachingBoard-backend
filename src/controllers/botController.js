// The WhatsApp bot (Cloudflare Worker) asks Render for a child's facts and asks Render to do things
// (save the parent's number, register a महा-Test, send an app push). Every call carries X-Bot-Key.
// Admin › CRM gets a short-lived token here to call the Worker directly.
const GuestLead = require('../models/GuestLead');
const Batch = require('../models/Batch');
const Attempt = require('../models/Attempt');
const StudentSubscription = require('../models/StudentSubscription');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const Quiz = require('../models/Quiz');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const BOT = require('../utils/waBot');
const { sendToUser } = require('../utils/fcm');

const GID = /^[0-9A-F]{10}$/;
function requireBotKey(req, _res, next) {
  if (!BOT.keyOk(req)) return next(new AppError('Not allowed', 401));
  next();
}

// everything waFlow.js's `sync` event understands about one child
async function syncOf(gid) {
  const g = require('./guestController');
  const lead = await GuestLead.findOne({ gid }).lean();
  if (!lead) return null;
  const code = `GUEST-${gid}`;
  const [batch, free, first, last, batches, totalTests] = await Promise.all([
    lead.batch ? Batch.findOne({ name: lead.batch }, 'name monthly_price yearly_price').lean() : null,
    g.freeTestCounts().catch(() => ({})),
    Attempt.findOne({ student_code: lead.converted_code ? { $in: [code, lead.converted_code] } : code }, 'submitted_at').sort({ submitted_at: 1 }).lean(),
    Attempt.findOne({ student_code: lead.converted_code ? { $in: [code, lead.converted_code] } : code }, 'marks_obtained max_marks score total_questions').sort({ submitted_at: -1 }).lean(),
    Batch.find({ is_active: { $ne: false } }, 'name').sort({ name: 1 }).lean(),
    lead.batch ? Quiz.countDocuments({ batch: lead.batch, status: 'published' }).catch(() => 0) : 0,
  ]);
  const paid = lead.converted_code ? !!(await StudentSubscription.exists({ student_code: lead.converted_code, payment_verified: true, is_trial: false })) : false;
  // the class's next महा-Test and whether this child is registered
  const now = new Date();
  const next = lead.batch ? await WeeklyEvent.findOne({ batch: lead.batch, is_trial: { $ne: true }, status: { $ne: 'skipped' }, ends_at: { $gt: now } }).sort({ starts_at: 1 }).select('_id starts_at').lean() : null;
  const mtReg = next ? !!(await WeeklyEntry.exists({ event_id: String(next._id), student_code: lead.converted_code || code })) : false;
  return {
    name: lead.name || undefined,
    cls: lead.batch || '',
    freeTotal: free[lead.batch] || 0,
    totalTests: totalTests || 0,
    courses: batches.map(b => b.name),
    prices: { monthly: batch?.monthly_price || 0, yearly: batch?.yearly_price || 0 },
    mtNext: next ? next.starts_at : null,
    mtReg,
    paid,
    app: !!lead.device_token,
    pushOn: !!lead.device_token,
    testsDone: lead.tests || 0,
    firstTestAt: first?.submitted_at || null,
    offerEnd: lead.offer?.expires_at || null,
    last: last ? { score: last.max_marks ? last.marks_obtained : last.score, total: last.max_marks || last.total_questions, title: lead.last_test || '' } : null,
  };
}

// GET /api/guest/bot/lead/:gid
const lead = asyncHandler(async (req, res) => {
  const gid = String(req.params.gid || '').toUpperCase();
  if (!GID.test(gid)) throw new AppError('gid?', 400);
  const data = await syncOf(gid);
  if (!data) throw new AppError('Lead not found', 404);
  res.json({ success: true, data });
});

// POST /api/guest/bot/action { gid, action, mobile?, name?, text?, buttons? }
const action = asyncHandler(async (req, res) => {
  const g = require('./guestController');
  const gid = String(req.body?.gid || '').toUpperCase();
  const act = String(req.body?.action || '');
  if (!GID.test(gid)) throw new AppError('gid?', 400);
  const lead = await GuestLead.findOne({ gid });
  if (!lead) return res.json({ success: true, skipped: 'no lead' });   // nothing to do; don't make the Worker retry

  if (act === 'lead') {
    // the parent wrote to the bot themselves: that is the number (and the consent) — the same as the form
    const mobile = g.normalizeMobile(req.body?.mobile);
    if (mobile && !lead.parent_mobile) { lead.parent_mobile = mobile; lead.consent_at = new Date(); }
    if (!lead.steps.includes('lead')) lead.steps.push('lead');
    await lead.save();
    g.noteLead(gid);
    return res.json({ success: true });
  }
  if (act === 'name') {
    const name = String(req.body?.name || '').trim().slice(0, 30);
    if (name && !lead.name) { lead.name = name; await lead.save(); }
    return res.json({ success: true });
  }
  if (act === 'mt_register') {
    const ev = lead.batch ? await WeeklyEvent.findOne({ batch: lead.batch, is_trial: { $ne: true }, status: { $ne: 'skipped' }, ends_at: { $gt: new Date() } }).sort({ starts_at: 1 }).lean() : null;
    if (!ev) return res.json({ success: true, skipped: 'no महा-Test' });
    const code = lead.converted_code || `GUEST-${gid}`;
    // registered from WhatsApp: the name stays hidden on the toppers list until they choose otherwise in the app
    if (!lead.toppers_consent_at) { lead.toppers_consent_at = new Date(); lead.hide_in_toppers = true; await lead.save(); }
    await WeeklyEntry.updateOne({ event_id: String(ev._id), student_code: code },
      { $setOnInsert: { name: lead.name || 'Student', is_guest: !lead.converted_code, registered_at: new Date() } }, { upsert: true });
    require('./weeklyController').clearPublicCache();
    return res.json({ success: true });
  }
  if (act === 'push') {
    if (lead.device_token) await sendToUser(lead.device_token, 'NKs EduOrbit', String(req.body?.text || '').slice(0, 180), { kind: 'wa_bot', buttons: JSON.stringify(req.body?.buttons || []) }).catch(err => console.warn('[wa bot] push', err.message));
    return res.json({ success: true });
  }
  if (act === 'app_msg') return res.json({ success: true, skipped: 'app banner needs the next app version' });
  throw new AppError('Unknown action', 400);
});

// GET /api/guest/bot-config — public: the bot's WhatsApp number when the bot is on ('' = website keeps its forms)
const config = (_req, res) => {
  const n = String(process.env.WA_BOT_NUMBER || '').replace(/\D/g, '');
  res.json({ success: true, data: { number: BOT.on() && /^91\d{10}$/.test(n) ? n : '' } });
};

// GET /api/guest/admin/bot-token — Admin › CRM: where the Worker is + a 12-hour token
const adminToken = asyncHandler(async (_req, res) => {
  if (!BOT.on()) return res.json({ success: true, data: { ready: false } });
  res.json({ success: true, data: { ready: true, url: process.env.WA_WORKER_URL.replace(/\/$/, ''), token: BOT.adminToken() } });
});

module.exports = { requireBotKey, lead, action, adminToken, syncOf, config };
