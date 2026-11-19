// 🎁 First-payment discounts, run by the admin (owner 2026-11-19: "admin offer कायम ठेवू शकत नाही" — stop,
// edit and name them, e.g. "दिवाळी offer"). One settings document; everything that shows or charges an offer reads
// it through here: the free part's test offer (step 1 % for N hours, then step 2 % for M hours), the team's own
// offer (NKs Team app), and the "stop everything now" switch.
//
// Promises are kept: an offer already given keeps its own percent and times (they are saved on the family when it
// is given). Only "🛑 सगळ्या थांबवा", a family's own "🛑 सूट थांबवा", or the end date (कधीपर्यंत) stop a running one.
const crypto = require('crypto');
const { mongoose } = require('../config/db');

const DEFAULTS = {
  test_enabled: true,
  name: '',                 // e.g. "दिवाळी offer" — shown with the offer everywhere
  step1_percent: 50, step1_hours: 24,
  step2_percent: 30, step2_hours: 48,   // 0 % or 0 hours = no second step
  repeat: 'month',          // 'month' = again each calendar month · 'days' = again after repeat_days · 'once' = never again
  repeat_days: 30,
  start_date: '',           // IST 'YYYY-MM-DD' — no new offer before it ('' = now)
  until: '',                // IST 'YYYY-MM-DD' — every test offer ends that night ('' = no end)
  campaign: 'c0',           // a new campaign ("नवीन offer — सगळ्यांना परत") lets every family get it once more
  team_enabled: true,
  team_percents: [30, 50],
  team_hours: 3,
  stop_all_at: null,        // offers given before this moment are over
};

const schema = new mongoose.Schema({
  key:           { type: String, default: 'main', unique: true },
  test_enabled:  { type: Boolean, default: DEFAULTS.test_enabled },
  name:          { type: String, default: '', trim: true, maxlength: 40 },
  step1_percent: { type: Number, min: 0, max: 90, default: DEFAULTS.step1_percent },
  step1_hours:   { type: Number, min: 1, max: 24 * 60, default: DEFAULTS.step1_hours },
  step2_percent: { type: Number, min: 0, max: 90, default: DEFAULTS.step2_percent },
  step2_hours:   { type: Number, min: 0, max: 24 * 60, default: DEFAULTS.step2_hours },
  repeat:        { type: String, enum: ['month', 'days', 'once'], default: 'month' },
  repeat_days:   { type: Number, min: 1, max: 365, default: 30 },
  start_date:    { type: String, default: '' },
  until:         { type: String, default: '' },
  campaign:      { type: String, default: 'c0' },
  team_enabled:  { type: Boolean, default: true },
  team_percents: { type: [Number], default: [30, 50] },
  team_hours:    { type: Number, min: 1, max: 72, default: 3 },
  stop_all_at:   { type: Date, default: null },
  updated_by:    { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false });
const OfferConfig = mongoose.models.OfferConfig || mongoose.model('OfferConfig', schema);

const IST = 5.5 * 3600e3;
const H = 3600e3;
const istMonth = (d = new Date()) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 7);
const _dayEnd = key => new Date(`${key}T23:59:59.999+05:30`).getTime();

// the settings in memory (the offer checks run on every page / payment); reloaded every minute and on every save
let _cfg = { ...DEFAULTS };
let _loadedAt = 0;
async function refresh() {
  try {
    const d = await OfferConfig.findOne({ key: 'main' }).lean();
    _cfg = { ...DEFAULTS, ...(d || {}) };
    _loadedAt = Date.now();
  } catch (err) { console.warn('[offer] settings load failed:', err.message); }
  return _cfg;
}
function current() {
  if (Date.now() - _loadedAt > 60e3) { _loadedAt = Date.now(); refresh(); }   // background; the old copy meanwhile
  return _cfg;
}

const _stoppedByAll = (issued, cfg) => cfg.stop_all_at && issued && new Date(issued).getTime() < new Date(cfg.stop_all_at).getTime();

// the team's offer running now, or null
function teamNow(lead, now = Date.now(), cfg = current()) {
  const t = lead?.team_offer;
  if (!t?.expires_at || !t.percent || t.stopped_at || _stoppedByAll(t.issued_at, cfg)) return null;
  const e = new Date(t.expires_at).getTime();
  return now < e ? { percent: t.percent, ends: new Date(e), stage: 'team', name: '' } : null;
}

// a test offer's steps as promised: [{ percent, ends }] (cut at its end date and today's end date)
function testSteps(o, cfg = current()) {
  if (!o?.expires_at) return [];
  const caps = [o.until, cfg.until].filter(Boolean).map(_dayEnd);
  const cap = caps.length ? Math.min(...caps) : Infinity;
  const e1 = new Date(o.expires_at).getTime();
  // offers given before 2026-11-19 had no saved second step: the rule then (30 % for 48 h)
  const p2 = o.step2_percent ?? 30, h2 = o.step2_hours ?? 48;
  const steps = [{ percent: o.percent || 50, ends: Math.min(e1, cap) }];
  if (p2 > 0 && h2 > 0 && e1 < cap) steps.push({ percent: p2, ends: Math.min(e1 + h2 * H, cap) });
  return steps.map(s => ({ percent: s.percent, ends: new Date(s.ends) }));
}

// the offer right now: { percent, ends, stage, name } or null — the team's offer first (it is given on purpose)
function offerNow(lead, now = Date.now(), cfg = current()) {
  const team = teamNow(lead, now, cfg);
  if (team) return team;
  const o = lead?.offer;
  if (!o?.expires_at || o.stopped_at || _stoppedByAll(o.issued_at, cfg)) return null;
  const steps = testSteps(o, cfg);
  for (let i = 0; i < steps.length; i++) if (now < steps[i].ends.getTime()) return { percent: steps[i].percent, ends: steps[i].ends, stage: i + 1, name: o.name || '' };
  return null;
}

// may this family get a new test offer now? (existing = its last one)
function mayGive(existing, now = new Date(), cfg = current()) {
  if (!cfg.test_enabled) return false;
  const key = new Date(now.getTime() + IST).toISOString().slice(0, 10);
  if (cfg.start_date && key < cfg.start_date) return false;
  if (cfg.until && key > cfg.until) return false;
  if (!existing?.issued_at) return true;
  if ((existing.campaign || 'c0') !== cfg.campaign) return true;          // a new campaign: everyone once more
  if (cfg.repeat === 'once') return false;
  if (cfg.repeat === 'days') return now.getTime() - new Date(existing.issued_at).getTime() >= cfg.repeat_days * 864e5;
  return existing.month !== istMonth(now);
}

// the test offer to save on a family now (a snapshot of today's rule — kept even if the settings change later)
function newOffer(now = new Date(), cfg = current()) {
  return {
    percent: cfg.step1_percent, issued_at: now, expires_at: new Date(now.getTime() + cfg.step1_hours * H), month: istMonth(now),
    step2_percent: cfg.step2_percent, step2_hours: cfg.step2_hours, name: cfg.name || '', until: cfg.until || '', campaign: cfg.campaign,
  };
}

// what pages, the app and the bot may show about the rule (no secrets)
function publicView(cfg = current()) {
  const now = new Date();
  const key = new Date(now.getTime() + IST).toISOString().slice(0, 10);
  const on = !!cfg.test_enabled && !(cfg.until && key > cfg.until) && !(cfg.start_date && key < cfg.start_date);
  return {
    on, name: cfg.name || '', p1: cfg.step1_percent, h1: cfg.step1_hours,
    p2: cfg.step2_hours > 0 ? cfg.step2_percent : 0, h2: cfg.step2_percent > 0 ? cfg.step2_hours : 0,
    until: cfg.until || '', repeat: cfg.repeat, repeat_days: cfg.repeat_days,
    team_on: !!cfg.team_enabled, team_percents: cfg.team_percents || [], team_hours: cfg.team_hours,
  };
}

// Admin save: checked values only. `newCampaign` lets every family get the (new) offer once more.
async function save(body, by = 'Admin') {
  const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const date = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
  const cur = await refresh();
  const set = {
    test_enabled: body.test_enabled !== undefined ? body.test_enabled === true : cur.test_enabled,
    name: body.name !== undefined ? String(body.name || '').trim().slice(0, 40) : cur.name,
    step1_percent: n(body.step1_percent ?? cur.step1_percent, 1, 90, cur.step1_percent),
    step1_hours: n(body.step1_hours ?? cur.step1_hours, 1, 1440, cur.step1_hours),
    step2_percent: n(body.step2_percent ?? cur.step2_percent, 0, 90, cur.step2_percent),
    step2_hours: n(body.step2_hours ?? cur.step2_hours, 0, 1440, cur.step2_hours),
    repeat: ['month', 'days', 'once'].includes(body.repeat) ? body.repeat : cur.repeat,
    repeat_days: n(body.repeat_days ?? cur.repeat_days, 1, 365, cur.repeat_days),
    start_date: body.start_date !== undefined ? date(body.start_date) : cur.start_date,
    until: body.until !== undefined ? date(body.until) : cur.until,
    team_enabled: body.team_enabled !== undefined ? body.team_enabled === true : cur.team_enabled,
    team_percents: body.team_percents !== undefined
      ? [...new Set([].concat(body.team_percents || []).map(x => Math.round(Number(x))).filter(x => x >= 1 && x <= 90))].sort((a, b) => a - b).slice(0, 4)
      : cur.team_percents,
    team_hours: n(body.team_hours ?? cur.team_hours, 1, 72, cur.team_hours),
    updated_by: by,
  };
  if (set.start_date && set.until && set.until < set.start_date) { const e = new Error('"कधीपर्यंत" ही तारीख "कधीपासून" नंतरची हवी'); e.status = 400; throw e; }
  if (set.team_enabled && !set.team_percents.length) { const e = new Error('Team सूटचे किमान एक % द्या'); e.status = 400; throw e; }
  if (body.new_campaign === true) set.campaign = 'c' + crypto.randomBytes(4).toString('hex');
  if (body.stop_all === true) set.stop_all_at = new Date();
  await OfferConfig.updateOne({ key: 'main' }, { $set: set }, { upsert: true });
  return refresh();
}

module.exports = { DEFAULTS, OfferConfig, refresh, current, offerNow, teamNow, testSteps, mayGive, newOffer, publicView, save, istMonth };
