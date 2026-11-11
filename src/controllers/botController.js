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
const User = require('../models/User');
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
  const acc = lead.converted_code ? await User.findOne({ role: 'student', student_code: lead.converted_code }, 'role free_tier expiry_date device_id device_token last_login_at').lean() : null;
  // paid = a Razorpay payment, or an account with full access (Admin activated it: not free tier, not expired) —
  // such a child must never get "free test" / offer messages
  const paid = lead.converted_code ? !!((await StudentSubscription.exists({ student_code: lead.converted_code, payment_verified: true, is_trial: false }))
    || (acc && require('../utils/contentAccess').hasFullAccess(acc))) : false;
  // the class's next महा-Test and whether this child is registered
  const now = new Date();
  const next = lead.batch ? await WeeklyEvent.findOne({ batch: lead.batch, is_trial: { $ne: true }, status: { $ne: 'skipped' }, ends_at: { $gt: now } }).sort({ starts_at: 1 }).select('_id starts_at').lean() : null;
  const mtReg = next ? !!(await WeeklyEntry.exists({ event_id: String(next._id), student_code: lead.converted_code || code })) : false;
  return {
    name: lead.name || undefined,
    cls: lead.batch || '',
    freeTotal: free[lead.batch] || 0,
    totalTests: totalTests || 0,
    // a Regular class: free chapters ("धडे") instead of free tests
    kind: batch ? require('../utils/courseKind').kindOf(await Batch.findOne({ name: lead.batch }, 'name standard kind').lean()) : '',
    freeLessons: lead.batch ? (await require('../utils/contentAccess').listFreeChapters().catch(() => [])).filter(f => String(f.batch).trim().toLowerCase() === String(lead.batch).trim().toLowerCase()).length : 0,
    courses: batches.map(b => b.name),
    prices: { monthly: batch?.monthly_price || 0, yearly: batch?.yearly_price || 0 },
    mtNext: next ? next.starts_at : null,
    mtReg,
    paid,
    app: !!(lead.device_token || acc?.device_id || acc?.last_login_at),
    pushOn: !!(lead.device_token || acc?.device_token),
    acct: lead.converted_code ? { code: lead.converted_code, pin: lead.auto_pin || '' } : null,
    testsDone: lead.tests || 0,
    firstTestAt: first?.submitted_at || lead.offer?.issued_at || null,
    offerEnd: lead.offer?.expires_at || null,
    last: last ? { score: last.max_marks ? last.marks_obtained : last.score, total: last.max_marks || last.total_questions, title: lead.last_test || '' } : null,
  };
}

// ── a family that wrote to the bot first ──
const _slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const _adNames = new Map();   // Meta ad id → our ad name (Admin › Ads names every Meta ad with our ad id)
async function _adName(adId) {
  if (!/^\d{5,25}$/.test(String(adId || ''))) return '';
  if (_adNames.has(adId)) return _adNames.get(adId);
  let name = '';
  try { const META = require('../utils/meta'); if (META.configured().ok) name = String((await META.graph(adId, { fields: 'name' }))?.name || ''); } catch (err) { console.warn('[wa bot] ad name', err.message); }
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  _adNames.set(adId, name);
  return name;
}
// the class: our ad's name starts with the class's slug ("8th-nmms-exam-26-27-batc-…"); else a class named in the
// ad's text / the parent's message ("8th NMMS"); else none (the bot asks)
async function _guessBatch(adName, text) {
  const all = await Batch.find({ is_active: { $ne: false } }, 'name').lean();
  if (adName) {
    const hit = all.map(b => ({ b, s: _slug(b.name) })).filter(x => x.s && adName.startsWith(x.s + '-')).sort((a, c) => c.s.length - a.s.length)[0];
    if (hit) return hit.b.name;
  }
  const words = String(text || '').toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) || [];
  if (!words.length) return '';
  // every word of the class's short form (e.g. "8th" + "nmms") must be in the text; the most specific wins
  const scored = all.map(b => {
    const key = String(b.name).toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) || [];
    const core = key.filter(w => !/^(exam|batch|\d\d-\d\d|\d{2})$/.test(w)).slice(0, 3);
    return { b, n: core.length && core.every(w => words.includes(w)) ? core.length : 0 };
  }).filter(x => x.n).sort((a, c) => c.n - a.n);
  return scored.length === 1 || (scored[0] && scored[0].n > (scored[1]?.n || 0)) ? scored[0].b.name : '';
}
async function _newLead(gid, b) {
  const g = require('./guestController');
  const mobile = g.normalizeMobile(b.mobile);
  if (!mobile) throw new AppError('mobile?', 400);
  // this number already came from the website (or an earlier chat): the same family
  const known = await GuestLead.findOne({ $or: [{ gid }, { parent_mobile: mobile }] }).sort({ created_at: -1 });
  let lead = known;
  if (!lead) {
    const ad = String(b.ad_id || '');
    const adName = ad ? await _adName(ad) : '';
    const batch = await _guessBatch(adName, [b.text, b.headline, b.ad_body].filter(Boolean).join(' '));
    lead = new GuestLead({
      gid, source: ad ? 'ad' : 'whatsapp',
      // a click-to-WhatsApp ad: our ad's name (+ "-wa"), else Meta's own ad id
      ref: ad ? (adName ? (adName.endsWith('-wa') ? adName : adName + '-wa') : 'wa-' + ad).slice(0, 40) : '',
      batch, parent_mobile: mobile, consent_at: new Date(), steps: ['opened', 'lead'],
    });
    await lead.save();
  } else if (!lead.parent_mobile) {
    lead.parent_mobile = mobile; lead.consent_at = new Date();
    if (!lead.steps.includes('lead')) lead.steps.push('lead');
    await lead.save();
  }
  return { gid: lead.gid, ...(await syncOf(lead.gid)), mobile };
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
  // a parent wrote to the bot from a number it does not know (a click-to-WhatsApp ad, or just "hi"): a lead with
  // that number (they wrote first = the consent). Same number already here from the website → that lead.
  if (act === 'new_lead') {
    const data = await _newLead(gid, req.body || {});
    // made later from the bot's job queue (Render was asleep): the bot gets the facts (class, courses…) now
    if (req.body?.queued) BOT.notify(data.gid, 'sync', {}, { sync: data });
    return res.json({ success: true, data });
  }
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
    // name + number from WhatsApp: the free account (code + PIN, free tests only) as on the website
    if (lead.parent_mobile && lead.batch && !lead.converted_code) {
      const acct = await g.autoAccount(lead).catch(err => { console.warn('[wa bot] account', err.message); return null; });
      if (acct) BOT.notify(gid, 'sync', {}, { sync: await syncOf(gid) });
    }
    return res.json({ success: true });
  }
  if (act === 'batch') {
    // the parent chose the class on WhatsApp
    const want = String(req.body?.batch || '').trim();
    const b = want ? await Batch.findOne({ name: want, is_active: { $ne: false } }, 'name').lean() : null;
    if (b && !lead.batch) { lead.batch = b.name; await lead.save(); }
    return res.json({ success: true, data: await syncOf(gid) });
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
    // the phone now belongs to a student account with full access: no free-test / offer push from the bot
    const owner = lead.device_token ? await User.findOne({ role: 'student', device_token: lead.device_token }, 'role free_tier expiry_date').lean() : null;
    if (owner && require('../utils/contentAccess').hasFullAccess(owner)) return res.json({ success: true, skipped: 'paid student' });
    if (lead.device_token) await sendToUser(lead.device_token, 'NKs EduOrbit', String(req.body?.text || '').slice(0, 180), { kind: 'wa_bot', buttons: JSON.stringify(req.body?.buttons || []) }).catch(err => console.warn('[wa bot] push', err.message));
    return res.json({ success: true });
  }
  if (act === 'app_msg') return res.json({ success: true, skipped: 'app banner needs the next app version' });
  throw new AppError('Unknown action', 400);
});

// POST /api/guest/bot/wa-login { nonce, mobile } — "LOGIN <nonce>" from WhatsApp (forgot PIN): the parent's number checks the account
const waLogin = asyncHandler(async (req, res) => {
  const nonce = String(req.body?.nonce || '').toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(nonce)) throw new AppError('nonce?', 400);
  res.json({ success: true, data: await require('./helpController').waLoginFromBot(nonce, req.body?.mobile) });
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

module.exports = { requireBotKey, lead, action, adminToken, syncOf, config, waLogin };
