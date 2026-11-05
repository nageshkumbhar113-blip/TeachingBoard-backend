// Admin › 🗺️ Site / Exams — the public exam pages on nkseduorbit.in.
//  • the admin edits an exam (Mongo, SiteExam), marks it checked (verified_on), and presses Publish;
//  • Publish copies every enabled + checked exam into `live` and asks Vercel to rebuild the site
//    (VERCEL_DEPLOY_HOOK); the Vercel build (site-build/build.mjs) reads GET /api/site/exams and
//    writes the static pages, sitemap.xml and robots.txt.
//  • sampleMcqs(): real questions from a class's free tests — for the page animation and the ads.
const Batch = require('../models/Batch');
const Quiz = require('../models/Quiz');
const SiteExam = require('../models/SiteExam');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isQuizLocked } = require('../utils/contentAccess');
const SEED = require('../data/siteExamsSeed');

const STALE_DAYS = 180;
const FIELDS = ['order', 'group', 'name', 'name_en', 'full_name', 'class_label', 'purpose', 'benefit', 'eligibility', 'pattern', 'syllabus',
  'official_url', 'dates', 'faq', 'batch', 'animation', 'ad_loss_mr', 'ad_loss_en', 'enabled'];
const _txt = (s, n) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);

// ── real questions from the class's free tests (text only: no picture, no formula) ──
const _plain = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const _hasMath = s => /\$|\\\(|\\\[|\\frac|\^\{|_\{/.test(String(s || ''));
let _mcqCache = new Map();
async function sampleMcqs(batchName, n = 8) {
  if (!batchName) return [];
  const hit = _mcqCache.get(batchName);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list.slice(0, n);
  const visitor = { role: 'student', status: 'active', free_tier: true, expiry_date: null };
  const quizzes = await Quiz.find({ batch: batchName, status: 'published' }, 'batch subject chapter paper_mode sections questions').lean();
  const out = [];
  for (const qz of quizzes) {
    if (await isQuizLocked(visitor, qz)) continue;
    for (const q of qz.questions || []) {
      if (q.image || Object.values(q.option_images || {}).some(Boolean)) continue;
      const o = q.options || {};
      const keys = ['A', 'B', 'C', 'D'].filter(k => _plain(o[k]));
      if (keys.length !== 4) continue;
      const text = _plain(q.question), opts = keys.map(k => _plain(o[k]));
      if (!text || text.length > 120 || opts.some(t => t.length > 26) || _hasMath(q.question) || opts.some(_hasMath)) continue;
      const right = o[q.answer] !== undefined ? q.answer : keys.find(k => _plain(o[k]) === _plain(q.answer));
      if (!right) continue;
      const why = _plain(q.explanation);
      out.push({ q: text, options: opts, answer: keys.indexOf(right), why: _hasMath(why) ? '' : why.slice(0, 140), subject: qz.subject || '' });
      if (out.length >= 30) break;
    }
    if (out.length >= 30) break;
  }
  // questions with an explanation first (it becomes the "युक्ती")
  out.sort((a, b) => (b.why ? 1 : 0) - (a.why ? 1 : 0));
  _mcqCache.set(batchName, { at: Date.now(), list: out });
  return out.slice(0, n);
}

function _clean(body) {
  const o = {};
  for (const k of FIELDS) {
    if (body[k] === undefined) continue;
    const v = body[k];
    if (k === 'order') o.order = Math.max(0, Math.min(9999, parseInt(v, 10) || 0));
    else if (k === 'enabled') o.enabled = !!v;
    else if (k === 'group') o.group = v === 'senior' ? 'senior' : 'school';
    else if (k === 'animation') o.animation = ['auto', 'days', 'question', 'none'].includes(v) ? v : 'auto';
    else if (k === 'official_url') {
      const u = _txt(v, 300);
      if (u && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) throw new AppError('Official link https:// ने सुरू व्हायला हवी', 400);
      o.official_url = u;
    } else if (k === 'dates') {
      o.dates = (Array.isArray(v) ? v : []).slice(0, 8).map(d => {
        const t = d?.date ? new Date(d.date) : null;
        return { label: _txt(d?.label, 60), date: t && !isNaN(t) ? t : null, note: _txt(d?.note, 80) };
      }).filter(d => d.label);
    } else if (k === 'faq') {
      o.faq = (Array.isArray(v) ? v : []).slice(0, 12).map(f => ({ q: _txt(f?.q, 200), a: _txt(f?.a, 1200) })).filter(f => f.q && f.a);
    } else {
      const max = { name: 80, name_en: 80, full_name: 200, class_label: 40, purpose: 400, benefit: 80, eligibility: 1500, pattern: 2000, syllabus: 2000, batch: 120, ad_loss_mr: 80, ad_loss_en: 80 }[k];
      o[k] = _txt(v, max);
    }
  }
  return o;
}
// the public copy of an exam (what the website gets)
function _liveCopy(e) {
  const o = {};
  for (const k of ['slug', ...FIELDS, 'verified_on']) o[k] = e[k];
  return o;
}
const _stale = e => !e.verified_on || (Date.now() - new Date(e.verified_on).getTime()) / 864e5 > STALE_DAYS;
const _changed = e => !e.live || JSON.stringify(_liveCopy(e)) !== JSON.stringify(e.live);

// GET /api/site/admin/exams
exports.adminList = asyncHandler(async (_req, res) => {
  const [exams, batches] = await Promise.all([
    SiteExam.find({}).sort({ order: 1, name: 1 }).lean(),
    Batch.find({}, 'name').sort({ name: 1 }).lean(),
  ]);
  res.json({
    success: true,
    hook: !!process.env.VERCEL_DEPLOY_HOOK,
    site: process.env.PUBLIC_SITE_URL || 'https://nkseduorbit.in',
    stale_days: STALE_DAYS,
    seed_count: SEED.length,
    last_publish: exams.reduce((t, e) => (e.published_at && (!t || e.published_at > t) ? e.published_at : t), null),
    batches: batches.map(b => b.name),
    exams: exams.map(e => ({ ...e, live: undefined, is_live: !!e.live, changed: _changed(e), stale: _stale(e) })),
  });
});

// POST /api/site/admin/seed — add the starting draft for every exam that is not there yet
exports.adminSeed = asyncHandler(async (_req, res) => {
  const have = new Set((await SiteExam.find({}, 'slug').lean()).map(e => e.slug));
  const batches = (await Batch.find({}, 'name').lean()).map(b => b.name);
  const guess = slug => {
    const re = { nmms: /nmms/i, 'navodaya-6': /navodaya|नवोदय/i, 'jee-main': /\bjee\b/i, 'neet-ug': /neet/i, 'mht-cet': /cet/i, nda: /\bnda\b/i }[slug];
    return re ? batches.find(n => re.test(n)) || '' : '';
  };
  const add = SEED.filter(s => !have.has(s.slug)).map(s => ({ ...s, batch: guess(s.slug), verified_on: null }));
  if (add.length) await SiteExam.insertMany(add, { ordered: false });
  res.json({ success: true, added: add.length });
});

// PUT /api/site/admin/exams/:slug — save (creates a new exam when the slug is new)
exports.adminSave = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(slug)) throw new AppError('Slug: इंग्रजी लहान अक्षरं, अंक आणि - (उदा. nmms)', 400);
  const set = _clean(req.body || {});
  if (req.body?.verified === true) set.verified_on = new Date();
  if (req.body?.verified === false) set.verified_on = null;
  const cur = await SiteExam.findOne({ slug });
  if (!cur && !set.name) throw new AppError('परीक्षेचं नाव टाका', 400);
  const doc = cur ? Object.assign(cur, set) : new SiteExam({ slug, ...set });
  await doc.save();
  const e = doc.toObject();
  res.json({ success: true, exam: { ...e, live: undefined, is_live: !!e.live, changed: _changed(e), stale: _stale(e) } });
});

// POST /api/site/admin/publish — checked + enabled exams go live, then Vercel rebuilds the site
exports.adminPublish = asyncHandler(async (_req, res) => {
  const all = await SiteExam.find({});
  let live = 0, off = 0, unchecked = [];
  const now = new Date();
  for (const e of all) {
    if (!e.enabled) { if (e.live) { e.live = null; e.published_at = now; await e.save(); off++; } continue; }
    if (!e.verified_on) { unchecked.push(e.name); continue; }   // never publish facts nobody checked
    const plain = e.toObject();
    if (_changed(plain)) { e.live = JSON.parse(JSON.stringify(_liveCopy(plain))); e.published_at = now; e.markModified('live'); await e.save(); }
    live++;
  }
  let deploy = 'no-hook';
  const hook = process.env.VERCEL_DEPLOY_HOOK || '';
  if (hook) {
    if (!/^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\//.test(hook)) deploy = 'bad-hook';
    else {
      try {
        const r = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(15000) });
        deploy = r.ok ? 'started' : `failed-${r.status}`;
      } catch (err) { deploy = 'failed'; }
    }
  }
  res.json({ success: true, live, off, unchecked, deploy });
});

// GET /api/site/exams — public: the published exams (+ one real free-test question per class)
let _pubCache = null, _pubAt = 0;
exports.publicExams = asyncHandler(async (_req, res) => {
  if (!_pubCache || Date.now() - _pubAt > 60 * 1000) {
    const rows = await SiteExam.find({ live: { $ne: null } }, 'live').lean();
    const exams = rows.map(r => r.live).filter(e => e && e.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const e of exams) {
      const q = e.batch ? await sampleMcqs(e.batch, 3).catch(() => []) : [];
      e.samples = q;
    }
    _pubCache = { success: true, generated_at: new Date(), exams }; _pubAt = Date.now();
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json(_pubCache);
});

// for the ads: the exam linked to a class (live or draft), so ads and pages say the same thing
exports.examForBatch = async batchName => (batchName ? SiteExam.findOne({ batch: batchName, enabled: true }).sort({ order: 1 }).lean() : null);
exports.sampleMcqs = sampleMcqs;
exports._resetCache = () => { _pubCache = null; _mcqCache = new Map(); };
