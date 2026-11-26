// 📞 NKs Call Desk (owner 2026-11-26): one numbered day list per team member, every call / message recorded,
// an outcome (with a reason) after each one, the next contact set by rules, a lock so two members never call the
// same family, timed callbacks, the new-family 15-minute alert, discount approval, teachers sent to Admin, and the
// Admin's view (team table, speed to first call, source → paid, lost reasons, rules).
//
// Routes (all under /crm/desk/, the CRM token): home · day · lead/:gid · attempt/:gid · unlock/:gid · outcome/:gid
// · skip/:gid · teacher/:gid · disc/:gid · approvals · approve · admin · rules (GET / POST)
//
// Storage: table desk_day (made here if missing), kv 'desk_rules', 'desk_lock:<gid>', 'desk_disc', and in each
// lead's data: next { at, why, timed }, owner { id, name }, lastTeam { by, byId, at, result, reason }, noCall,
// attempts, noAnswer, teacherFwd.

import WA from './waFlow.js';
const sName = (d, cls) => (d && d.series && d.series.name) || WA.cleanName(cls || '');

export const RULES_DEFAULT = {
  daySize: 40,          // families in one member's day list
  newMin: 15,           // call a new family within this many minutes (the red alert)
  hours: [9, 21],       // calls between these hours (IST); outside: the list still opens, the alert waits
  talkDays: 2,          // ✅ talked → call again after this many days
  noAnswerMax: 3,       // 📵 this many times in a row → WhatsApp only
  payingCheckH: 11,     // 💳 will pay → check tomorrow at this hour
  renewDays: 3,         // 🔁 a monthly / yearly plan ending within this many days → renewal call
  staffDisc: [20, 30],  // discounts a member may give at once; others need the Admin
  lockMin: 20,          // a family stays locked to the caller this long after a call starts
  reasons: {
    talk: ['test देणार', 'app घेणार', 'घरच्यांशी बोलून सांगणार', 'माहिती पाठवली'],
    paying: ['आज', 'उद्या', 'पगार झाल्यावर'],
    later: ['आज रात्री', 'उद्या सकाळी', 'शनिवारी'],
    no: ['फी जास्त', 'दुसरा क्लास', 'English medium हवं', 'दुसरी इयत्ता', 'पाल्याला वेळ नाही', 'Phone नाही', 'इतर'],
  },
};
const OUTCOMES = ['talk', 'paying', 'noanswer', 'later', 'nocall', 'wrong', 'no'];
const OUT_NAMES = { talk: '✅ बोललो', paying: '💳 Pay करणार', noanswer: '📵 उचलला नाही', later: '⏰ नंतर', nocall: '🔕 Call नको', wrong: '☎️ नंबर चुकीचा', no: '❌ नको', teacher: '👩‍🏫 Admin कडे (शिक्षक)', skip: '⏭ नंतर (आज)', attempt: '📞 Call सुरू', wa: '💬 WhatsApp' };
const H = 3600e3, DAY = 864e5, IST = 5.5 * H;
const istDay = (t = Date.now()) => new Date(t + IST).toISOString().slice(0, 10);
const istHour = (t = Date.now()) => new Date(t + IST).getUTCHours();
const atIST = (t, h, m = 0, addDays = 0) => { const d = new Date(t + IST); d.setUTCDate(d.getUTCDate() + addDays); d.setUTCHours(h, m, 0, 0); return d.getTime() - IST; };
const endOfDay = (t = Date.now()) => atIST(t, 23, 59, 0) + 59999;
const ms = x => Date.parse(x || '') || 0;

let _ready = false;
async function ensure(env) {
  if (_ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS desk_day (
    day TEXT NOT NULL, by_id TEXT NOT NULL, n INTEGER NOT NULL, gid TEXT NOT NULL,
    cat INTEGER, why TEXT, tag TEXT, status TEXT DEFAULT '', outcome TEXT, done_at INTEGER,
    PRIMARY KEY (day, by_id, n))`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS desk_day_gid ON desk_day(day, gid)').run();
  _ready = true;
}
export async function rules(env, kvGet) {
  try { return { ...RULES_DEFAULT, ...(JSON.parse((await kvGet(env, 'desk_rules')) || '{}')) }; } catch { return { ...RULES_DEFAULT }; }
}

// ── what one family needs from the team now: { cat, why, tag } or null ──
// 1 💳 pay attempt · 2 📞 call asked / ❓ question · 3 ⏰ callback due · 4 🎁 offer running (tested) · 5 🔁 renewal ·
// 6 📲 uses the app, not paid · 7 🆕 new, no test yet (3 days) · 8 📋 follow-up due (the next date the rules set)
export function needOf(d, r, now, R, offerNow) {
  const t = now.getTime();
  if (d.tdemo || r.crm === 'teacher' || !r.mobile) return null;
  const touched = Math.max(ms(d.lastTeam && d.lastTeam.at), ms(d.teamSentAt));
  const payAt = Math.max(ms(d.checkoutAt), ms(d.paySeenAt), ms(d.payWantAt));
  const q = d.question && !d.question.answered ? d.question : null;
  const callAt = r.crm === 'call' ? (ms(d.callAt) || r.last_in || 0) : 0;
  const plan = d.desk && d.desk.plan;
  if (d.paid) {
    // a paying family: only the renewal, a few days before the plan ends
    const till = plan && ms(plan.till);
    if (till && till - t < R.renewDays * DAY && till > t - DAY && touched < till - (R.renewDays + 1) * DAY) return { cat: 5, why: `🔁 ${plan.period === 'yearly' ? 'Yearly' : 'Monthly'} plan ${new Date(till + IST).toISOString().slice(8, 10)}/${new Date(till + IST).toISOString().slice(5, 7)} ला संपतो`, tag: '🔁 Renewal' };
    return null;
  }
  if (d.closed) return null;
  if (payAt && t - payAt < 7 * DAY && payAt > touched) return { cat: 1, why: d.payIssueAt && ms(d.payIssueAt) >= payAt - 60e3 ? '💳 म्हणतात "pay केलं" — दिसत नाही' : ms(d.checkoutAt) === payAt ? '💳 Pay दाबलं, पूर्ण झालं नाही' : ms(d.paySeenAt) === payAt ? `💳 Pay पान उघडलं${d.paySeenN > 1 ? ' (' + d.paySeenN + ' वेळा)' : ''}` : '💳 Bot मध्ये Test Series मागितली', tag: '💳 Pay प्रयत्न' };
  if ((callAt && callAt > touched) || (q && ms(q.at) > touched)) return d.noCall && !q ? null : { cat: 2, why: q ? `❓ "${String(q.text).slice(0, 60)}"` : '📞 Call मागितला', tag: q ? '❓ प्रश्न' : '📞 Call मागितला' };
  if (d.noCall) return null;                                       // 🔕 never called again (WhatsApp / bot only)
  const next = d.next && d.next.at;
  if (next && next > endOfDay(t)) return null;                     // the rules set a later day
  if (touched >= atIST(t, 0)) return null;                         // already handled today
  if (next && next <= endOfDay(t)) return { cat: d.next.timed ? 3 : 8, why: d.next.why || '📋 पुढचा संपर्क आज', tag: d.next.timed ? '⏰ Callback' : '📋 Follow-up' };
  const o = offerNow(d, now);
  if (d.testsDone && o) return { cat: 4, why: `🎁 ${o.pct}% सूट · ${d.app ? 'app वापरतो' : 'test दिली, app नाही'}`, tag: '🎁 सूट' };
  if (d.app && !touched) return { cat: 6, why: `📲 App मध्ये ${d.testsDone || 0} tests, pay नाही`, tag: '📲 App · free' };
  if (!d.testsDone && r.created_at && t - r.created_at < 3 * DAY && !((d.backfilled || d.imported) && !d.lastInboundAt) && !touched) return { cat: 7, why: '🆕 Test अजून नाही', tag: '🆕 नवीन' };
  return null;
}
// 🔥 / 🌤 / ❄️ how keen the family is now
export function heat(d, now) {
  const t = now.getTime(); let s = 0;
  if (t - Math.max(ms(d.paySeenAt), ms(d.checkoutAt), ms(d.payWantAt)) < 3 * DAY) s += 3;
  if (d.desk && t - ms(d.desk.lastLogin) < 2 * DAY) s += 2;
  if ((d.testsDone || 0) >= 3) s += 1;
  if (t - ms(d.lastInboundAt) < 2 * DAY) s += 1;
  if ((d.noAnswer || 0) >= 2) s -= 1;
  return s >= 3 ? 'hot' : s >= 1 ? 'warm' : 'cold';
}
// where the family is on the way: 0 contact · 1 test · 2 app · 3 will pay · 4 paid
export const stageOf = d => d.paid ? 4 : d.payingAt ? 3 : d.app ? 2 : d.testsDone ? 1 : 0;

// the families that need the team, best first (shared by every member)
async function candidates(env, ctx, now) {
  const R = await rules(env, ctx.S.kvGet);
  const { results } = await env.DB.prepare("SELECT gid, name, cls, mobile, crm, last_in, created_at, updated_at, data FROM leads WHERE mobile IS NOT NULL AND (crm IS NULL OR crm NOT IN ('closed')) AND updated_at >= ? ORDER BY updated_at DESC LIMIT 3000").bind(now.getTime() - 120 * DAY).all();
  const out = [];
  for (const r of results || []) {
    const d = JSON.parse(r.data);
    const need = needOf(d, r, now, R, ctx.WA.offerNow);
    if (!need) continue;
    const pay = Math.max(ms(d.checkoutAt), ms(d.paySeenAt)), o = ctx.WA.offerNow(d, now);
    const key = need.cat * 1e14 + (need.cat === 1 ? -pay : need.cat === 3 || need.cat === 8 ? (d.next.at || 0) : need.cat === 4 && o ? o.end.getTime() : -(r.updated_at || 0));
    out.push({ gid: r.gid, name: r.name, cls: r.cls, owner: d.owner && d.owner.id, ...need, key });
  }
  return { R, rows: out.sort((a, b) => a.key - b.key) };
}

// a member's day list: made on the first open of the day (#1…#N), later urgent ones appended (#N+1…)
async function dayList(env, ctx, who, now) {
  await ensure(env);
  const day = istDay(now.getTime());
  const { R, rows } = await candidates(env, ctx, now);
  const { results: mine } = await env.DB.prepare('SELECT * FROM desk_day WHERE day = ? AND by_id = ? ORDER BY n').bind(day, who.id).all();
  const { results: taken } = await env.DB.prepare('SELECT gid, by_id FROM desk_day WHERE day = ?').bind(day).all();
  const takenBy = new Map((taken || []).map(x => [x.gid, x.by_id]));
  const { results: present } = await env.DB.prepare('SELECT DISTINCT by_id FROM desk_day WHERE day = ?').bind(day).all();
  const here = new Set((present || []).map(x => x.by_id)); here.add(who.id);
  // a family stays with its member (owner) while that member works today; else anyone may take it
  const free = rows.filter(x => !takenBy.has(x.gid) && (!x.owner || x.owner === who.id || !here.has(x.owner)));
  let list = mine || [];
  const add = async (x, n) => {
    await env.DB.prepare('INSERT OR IGNORE INTO desk_day (day, by_id, n, gid, cat, why, tag) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(day, who.id, n, x.gid, x.cat, x.why, x.tag).run();
    list.push({ day, by_id: who.id, n, gid: x.gid, cat: x.cat, why: x.why, tag: x.tag, status: '', outcome: null, done_at: null });
  };
  if (!list.length) { let n = 0; for (const x of free.slice(0, R.daySize)) await add(x, ++n); }
  else {
    // urgent ones that came up today (💳 / 📞 / ❓ / ⏰ due) go at the end with new numbers; at most 15 extra a day
    let n = Math.max(...list.map(x => x.n));
    for (const x of free.filter(f => f.cat <= 3).slice(0, Math.max(0, R.daySize + 15 - list.length))) await add(x, ++n);
  }
  const names = await leadsMap(env, list.map(x => x.gid));
  const locks = await Promise.all(list.map(x => lockOf(env, ctx, x.gid)));
  return list.map((x, i) => ({ n: x.n, gid: x.gid, cat: x.cat, why: x.why, tag: x.tag, status: x.status || '', outcome: x.outcome, done_at: x.done_at,
    name: names.get(x.gid)?.name || '', cls: names.get(x.gid)?.cls || '', heat: names.get(x.gid)?.heat || 'cold', lock: locks[i] && locks[i].id !== who.id ? locks[i].name : '' }));
}
async function leadsMap(env, gids) {
  const m = new Map(); if (!gids.length) return m;
  for (let i = 0; i < gids.length; i += 80) {
    const part = gids.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT gid, name, cls, data FROM leads WHERE gid IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results || []) { const d = JSON.parse(r.data); m.set(r.gid, { name: r.name || d.name, cls: sName(d, r.cls), heat: heat(d, new Date()), d }); }
  }
  return m;
}
async function lockOf(env, ctx, gid) {
  try { const l = JSON.parse((await ctx.S.kvGet(env, 'desk_lock:' + gid)) || 'null'); return l && l.until > Date.now() ? l : null; } catch { return null; }
}
async function markDone(env, who, gid, outcome) {
  await ensure(env);
  await env.DB.prepare("UPDATE desk_day SET status = 'done', outcome = ?, done_at = ? WHERE day = ? AND gid = ?").bind(outcome, Date.now(), istDay(), gid).run();
}

// the new families (created in the last hour, not contacted): the red alert with its minutes left
async function newAlert(env, R, now) {
  const since = now.getTime() - 6 * H;
  const { results } = await env.DB.prepare("SELECT gid, name, cls, mobile, created_at, data FROM leads WHERE mobile IS NOT NULL AND created_at >= ? AND (crm IS NULL OR crm NOT IN ('paid', 'closed', 'teacher')) ORDER BY created_at DESC LIMIT 30").bind(since).all();
  return (results || []).map(r => ({ r, d: JSON.parse(r.data) }))
    .filter(({ d }) => freshFamily(d))
    .map(({ r, d }) => ({ gid: r.gid, name: r.name || d.name || '', cls: sName(d, r.cls), from: fromOf(d),
      created_at: r.created_at, left_min: Math.round((r.created_at + R.newMin * 60e3 - now.getTime()) / 60e3) }));
}
const freshFamily = d => !d.paid && !d.tdemo && !d.lastTeam && !d.teamSentAt && !d.imported && !d.backfilled;
const fromOf = d => d.ctwaUntil ? 'WhatsApp ad' : d.via === 'form' ? 'Website नंबर' : d.source || d.via || '';

// 🔔 a new family → a push on the team's phones (owner 2026-11-26): checked every 5-minute tick, Render sends it
// (FCM, to every active member who logged in on the NKs Team app). Only in the call hours: the night's families
// come in one push when the hours start. kv 'desk_push_at' = the newest family already told.
export async function teamNewPush(env, kvGet, kvSet, queue, now = new Date()) {
  const t = now.getTime(), R = await rules(env, kvGet), h = istHour(t);
  const last = Number(await kvGet(env, 'desk_push_at')) || 0;
  if (!last) { await kvSet(env, 'desk_push_at', t); return 0; }   // the first run: from now on (not the old families)
  if (h < R.hours[0] || h >= R.hours[1]) return 0;
  const { results } = await env.DB.prepare("SELECT gid, name, cls, created_at, data FROM leads WHERE mobile IS NOT NULL AND created_at > ? AND (crm IS NULL OR crm NOT IN ('paid', 'closed', 'teacher')) ORDER BY created_at LIMIT 30")
    .bind(Math.max(last, t - 14 * H)).all();
  const rows = results || [];
  if (!rows.length) return 0;
  await kvSet(env, 'desk_push_at', rows[rows.length - 1].created_at);
  const fresh = rows.map(r => ({ r, d: JSON.parse(r.data) })).filter(({ d }) => freshFamily(d) && !d.lastAttempt);   // already being called: no push
  if (!fresh.length) return 0;
  const one = fresh.length === 1 ? fresh[0] : null;
  const who = ({ r, d }) => (r.name || d.name || 'नाव नाही') + (sName(d, r.cls) ? ' · ' + sName(d, r.cls) : '');
  const title = (one ? '🆕 नवीन पालक' : `🆕 ${fresh.length} नवीन पालक`) + ` — ${R.newMin} मिनिटांत call करा`;
  const text = one ? who(one) + (fromOf(one.d) ? ' · ' + fromOf(one.d) : '') : fresh.slice(0, 5).map(who).join(', ') + (fresh.length > 5 ? ' …' : '');
  await queue(env, fresh[0].r.gid, 'team_push', { title, text, one: one ? one.r.gid : '', n: fresh.length, at: t });
  return fresh.length;
}
// ⏰ the callbacks of today (a time was chosen)
async function callbacks(env, now, whoId) {
  const from = atIST(now.getTime(), 0), to = endOfDay(now.getTime());
  const { results } = await env.DB.prepare("SELECT gid, name, cls, data FROM leads WHERE data LIKE '%\"timed\":true%' AND (crm IS NULL OR crm NOT IN ('paid', 'closed')) LIMIT 500").all();
  return (results || []).map(r => ({ r, d: JSON.parse(r.data) }))
    .filter(({ d }) => d.next && d.next.timed && d.next.at >= from && d.next.at <= to && (!d.owner || d.owner.id === whoId) && !(ms(d.lastTeam && d.lastTeam.at) > (Number(d.next.setAt) || 0)))
    .map(({ r, d }) => ({ gid: r.gid, name: r.name || d.name || '', cls: sName(d, r.cls), at: d.next.at, why: d.next.why || '' }))
    .sort((a, b) => a.at - b.at);
}
// the best time to call: the hours they write to the bot most
function bestTime(msgs) {
  const hours = (msgs || []).filter(m => m.dir === 'in').map(m => istHour(m.at));
  if (hours.length < 2) return '';
  const b = { 'सकाळी 7–10': 0, 'दुपारी 12–4': 0, 'संध्याकाळी 5–8': 0, 'रात्री 8–10': 0 };
  for (const h of hours) { if (h >= 7 && h < 10) b['सकाळी 7–10']++; else if (h >= 12 && h < 16) b['दुपारी 12–4']++; else if (h >= 17 && h < 20) b['संध्याकाळी 5–8']++; else if (h >= 20 && h < 23) b['रात्री 8–10']++; }
  const best = Object.entries(b).sort((x, y) => y[1] - x[1])[0];
  return best && best[1] ? best[0] : '';
}

// the next contact after an outcome
function nextAfter(res, R, now, at, reason) {
  const t = now.getTime();
  if (res === 'talk') return { at: atIST(t, 17, 0, R.talkDays), why: `📋 ${R.talkDays} दिवसांपूर्वी बोललो${reason ? ' — ' + reason : ''}`, timed: false };
  if (res === 'paying') return { at: atIST(t, R.payingCheckH, 0, 1), why: `💳 "Pay करणार"${reason ? ' (' + reason + ')' : ''} — झालं का?`, timed: true };
  if (res === 'noanswer') return istHour(t) < 17 ? { at: atIST(t, 18, 0), why: '📵 सकाळी उचलला नाही', timed: true } : { at: atIST(t, 11, 0, 1), why: '📵 काल उचलला नाही', timed: false };
  if (res === 'later') { const a = Date.parse(at || '') || atIST(t, 11, 0, 1); return { at: a, why: `⏰ पालकांनी सांगितलेली वेळ${reason ? ' — ' + reason : ''}`, timed: true }; }
  return null;
}

// ── the routes ──
export async function deskRoute(env, req, url, who, ctx) {
  const { S, WA, json, withLead, act, appUsage, notifyRender } = ctx;
  const parts = url.pathname.split('/').filter(Boolean);   // crm, desk, …
  const now = new Date(), R = await rules(env, S.kvGet);
  const wl = (gid, fn) => withLead(env, gid, null, fn, { sync: false });
  const isAdmin = who.role === 'admin';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const seg = parts[2], gid = String(parts[3] || '').toUpperCase();

  if (seg === 'home' && req.method === 'GET') {
    const [list, alert, cbs, q, teachers, mine] = await Promise.all([
      dayList(env, ctx, who, now), newAlert(env, R, now), callbacks(env, now, who.id), ctx.questions(env), ctx.teacherList ? ctx.teacherList(env) : [],
      env.DB.prepare('SELECT action, COUNT(*) AS n FROM acts WHERE by_id = ? AND at >= ? GROUP BY action').bind(who.id, atIST(now.getTime(), 0)).all(),
    ]);
    const c = {}; for (const r of mine.results || []) c[r.action] = r.n;
    const tot = await env.DB.prepare("SELECT COUNT(*) AS all_n, SUM(CASE WHEN data LIKE '%\"lastTeam\":{%' OR data LIKE '%\"teamSentAt\"%' THEN 1 ELSE 0 END) AS touched, SUM(CASE WHEN crm = 'paid' THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN crm = 'closed' THEN 1 ELSE 0 END) AS closed FROM leads WHERE mobile IS NOT NULL AND data NOT LIKE '%\"tdemo\":{%'").first();
    const done = list.filter(x => x.status === 'done').length, next = list.find(x => x.status !== 'done' && !x.lock) || null;
    return json({ success: true, data: { me: who, rules: { newMin: R.newMin, staffDisc: R.staffDisc, reasons: R.reasons, hours: R.hours }, alert, callbacks: cbs,
      day: { total: list.length, done, next, items: list }, q: q.length, teachers: teachers.length,
      tStuck: teachers.filter(t => t.stuck || t.call_now).slice(0, 10).map(t => ({ gid: t.gid, name: t.name, stage: t.stage, why: t.call_why || '' })),
      today: { calls: c.attempt || 0, talk: c.talk || 0, paying: c.paying || 0, paid: c.paid || 0, wa: (c.wa || 0) + (c.reply || 0) },
      totals: { all: tot.all_n || 0, touched: tot.touched || 0, left: Math.max(0, (tot.all_n || 0) - (tot.touched || 0) - (tot.paid || 0) - (tot.closed || 0)), paid: tot.paid || 0, closed: tot.closed || 0 } } });
  }
  if (seg === 'day' && req.method === 'GET') return json({ success: true, data: await dayList(env, ctx, who, now) });

  if (seg === 'lead' && /^[0-9A-F]{10}$/.test(gid) && req.method === 'GET') {
    const lead = await S.getLead(env, gid);
    if (!lead) return json({ success: false, message: 'Lead नाही' }, 404);
    const [{ results: msgs }, sib, usage, lock] = await Promise.all([
      env.DB.prepare('SELECT dir, kind, body, at FROM msgs WHERE gid = ? ORDER BY at DESC, id DESC LIMIT 200').bind(gid).all(),
      lead.mobile ? env.DB.prepare('SELECT gid, name, cls, data FROM leads WHERE mobile = ? AND gid != ? LIMIT 5').bind(lead.mobile, gid).all() : { results: [] },
      Promise.race([appUsage(env, [gid]), new Promise(r => setTimeout(() => r({}), 1200))]).then(u => u[gid] || null).catch(() => null),
      lockOf(env, ctx, gid),
    ]);
    const o = lead.paid ? null : WA.offerNow(lead, now);
    const { results: hist } = await env.DB.prepare('SELECT at, by_name, action, detail FROM acts WHERE gid = ? ORDER BY at DESC LIMIT 40').bind(gid).all();
    let disc = []; try { disc = JSON.parse((await S.kvGet(env, 'desk_disc')) || '[]'); } catch {}
    return json({ success: true, data: {
      lead, heat: heat(lead, now), stage: stageOf(lead), offer: o ? { pct: o.pct, end: o.end.toISOString() } : null, open: WA.isOpen(lead, now),
      best: bestTime(msgs), usage, lock: lock && lock.id !== who.id ? lock : null, msgs: (msgs || []).reverse(),
      siblings: (sib.results || []).map(s => { const d = JSON.parse(s.data); return { gid: s.gid, name: s.name || d.name, cls: sName(d, s.cls), tests: d.testsDone || 0, paid: !!d.paid }; }),
      history: hist || [], names: OUT_NAMES, discReq: disc.find(x => x.gid === gid && !x.doneAt) || null,
    } });
  }
  if (req.method !== 'POST') return json({ success: false, message: 'Not found' }, 404);
  if (['attempt', 'unlock', 'outcome', 'skip', 'teacher', 'disc', 'tstep'].includes(seg)) {
    if (!/^[0-9A-F]{10}$/.test(gid) || !(await S.getLead(env, gid))) return json({ success: false, message: 'Lead नाही' }, 404);
  }
  // 📞 / 💬 tapped: the attempt is written at once and the family is locked to this member
  if (seg === 'attempt') {
    const l = await lockOf(env, ctx, gid);
    if (l && l.id !== who.id) return json({ success: false, code: 'LOCKED', message: `🔒 ${l.name} आत्ता बोलत आहेत` }, 409);
    await S.kvSet(env, 'desk_lock:' + gid, JSON.stringify({ id: who.id, name: who.name, until: Date.now() + R.lockMin * 60e3 }));
    const via = body.via === 'wa' ? 'wa' : 'call';
    await wl(gid, (lead, t) => { lead.attempts = (lead.attempts || 0) + 1; lead.lastAttempt = { by: who.name, byId: who.id, at: t.toISOString(), via }; if (!lead.owner) lead.owner = { id: who.id, name: who.name }; return []; });
    await act(env, who, gid, via === 'wa' ? 'wa' : 'attempt', via === 'wa' ? 'WhatsApp उघडलं' : 'Call');
    return json({ success: true });
  }
  // 👩‍🏫 Teacher Guide: the team did the step with the teacher on a call → the bot sends the next one
  if (seg === 'tstep') {
    await wl(gid, (lead, t) => WA.teacherTeamStep(lead, t));
    await act(env, who, gid, 'talk', 'शिक्षक: step पूर्ण करून दिली');
    return json({ success: true });
  }
  if (seg === 'unlock') { const l = await lockOf(env, ctx, gid); if (l && (l.id === who.id || isAdmin)) await S.kvSet(env, 'desk_lock:' + gid, 'null'); return json({ success: true }); }
  // ✅ the outcome (reason required where the rules have reasons for it): the next contact is set here
  if (seg === 'outcome') {
    const res = String(body.result || ''), reason = String(body.reason || '').trim().slice(0, 120), note = String(body.note || '').trim().slice(0, 200);
    if (!OUTCOMES.includes(res)) return json({ success: false, message: 'निकाल निवडा' }, 400);
    if (res === 'no' && reason.length < 2) return json({ success: false, message: '❌ नको — कारण निवडा' }, 400);
    let team = [], nextAt = null;
    await wl(gid, (lead, t) => {
      const out = [];
      lead.lastTeam = { by: who.name, byId: who.id, at: t.toISOString(), result: res, reason: [reason, note].filter(Boolean).join(' · ') };
      if (!lead.owner) lead.owner = { id: who.id, name: who.name };
      if (res === 'noanswer') lead.noAnswer = (lead.noAnswer || 0) + 1; else lead.noAnswer = 0;
      if (lead.question && res !== 'noanswer') lead.question.answered = t.toISOString();
      if (res === 'paying') { lead.payingAt = t.toISOString(); out.push(...WA.event(lead, 'call', { result: 'will_pay' }, t)); }
      if (res === 'nocall') { lead.noCall = true; if (lead.crm === 'call') lead.crm = null; lead.next = null; }
      if (res === 'wrong') { lead.wrongNumber = true; lead.closed = 'नंबर चुकीचा'; lead.stopped = true; lead.crm = 'closed'; lead.next = null; }
      if (res === 'no') { out.push(...WA.event(lead, 'call', { result: 'not_interested', reason }, t)); lead.next = null; }
      if (lead.crm === 'call' && res !== 'noanswer') lead.crm = null;
      if (res === 'noanswer' && lead.noAnswer >= R.noAnswerMax) { lead.noCall = true; lead.next = null; out.push({ to: 'log', tag: 'CALL', text: `📵 ${R.noAnswerMax} वेळा उचलला नाही → आता फक्त WhatsApp.` }); }
      else { const n = nextAfter(res, R, t, body.at, reason); if (n) { lead.next = { ...n, setAt: t.getTime() }; nextAt = n.at; } }
      out.push({ to: 'log', tag: 'CALL', text: `📞 ${who.name}: ${OUT_NAMES[res]}${reason ? ' — ' + reason : ''}${note ? ' · ' + note : ''}${res === 'noanswer' ? ` (${lead.noAnswer})` : ''}` });
      return out;
    }).then(r => { team = (r && r.team) || []; });
    await S.kvSet(env, 'desk_lock:' + gid, 'null');
    await markDone(env, who, gid, res);
    await act(env, who, gid, res, [reason, note].filter(Boolean).join(' · '));
    return json({ success: true, data: { team, next: nextAt } });
  }
  // ⏭ not now: to the end of today's list, with its reason
  if (seg === 'skip') {
    await ensure(env);
    const day = istDay(), row = await env.DB.prepare('SELECT n, cat, why, tag FROM desk_day WHERE day = ? AND by_id = ? AND gid = ?').bind(day, who.id, gid).first();
    if (row) {
      const mx = await env.DB.prepare('SELECT MAX(n) AS m FROM desk_day WHERE day = ? AND by_id = ?').bind(day, who.id).first();
      await env.DB.prepare('DELETE FROM desk_day WHERE day = ? AND by_id = ? AND gid = ?').bind(day, who.id, gid).run();
      await env.DB.prepare('INSERT INTO desk_day (day, by_id, n, gid, cat, why, tag) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(day, who.id, (mx.m || 0) + 1, gid, row.cat, row.why, row.tag).run();
    }
    await S.kvSet(env, 'desk_lock:' + gid, 'null');
    await act(env, who, gid, 'skip', String(body.why || '').slice(0, 80));
    return json({ success: true });
  }
  // 👩‍🏫 a teacher, not a parent: to the Admin's Teacher Demo list, out of the team's lists
  if (seg === 'teacher') {
    const note = String(body.note || '').trim().slice(0, 200);
    await wl(gid, (lead, t) => { lead.teacherFwd = { by: who.name, byId: who.id, at: t.toISOString(), note }; lead.crm = 'teacher'; lead.next = null; return [{ to: 'log', tag: 'CALL', text: `👩‍🏫 ${who.name}: शिक्षक — Admin कडे.${note ? ' ' + note : ''}` }]; });
    await markDone(env, who, gid, 'teacher');
    await act(env, who, gid, 'teacher', note);
    return json({ success: true });
  }
  // 🎁 a discount above the member's limit: asked of the Admin (the member's own limits are given straight from the app)
  if (seg === 'disc') {
    const pct = Number(body.pct) || 0;
    if (!(pct > 0 && pct <= 90)) return json({ success: false, message: 'टक्के?' }, 400);
    let list = []; try { list = JSON.parse((await S.kvGet(env, 'desk_disc')) || '[]'); } catch {}
    list = list.filter(x => !(x.gid === gid && !x.doneAt)).concat({ gid, pct, by: who.name, byId: who.id, why: String(body.why || '').slice(0, 120), at: Date.now() }).slice(-100);
    await S.kvSet(env, 'desk_disc', JSON.stringify(list));
    await act(env, who, gid, 'offer', `${pct}% — Admin ला विचारलं`);
    return json({ success: true, data: { asked: true } });
  }
  // ── Admin ──
  if (!isAdmin) return json({ success: false, message: 'हे फक्त Admin करू शकतो' }, 403);
  if (seg === 'approve') {
    let list = []; try { list = JSON.parse((await S.kvGet(env, 'desk_disc')) || '[]'); } catch {}
    const it = list.find(x => x.gid === String(body.gid || '').toUpperCase() && !x.doneAt);
    if (!it) return json({ success: false, message: 'विनंती नाही' }, 404);
    it.doneAt = Date.now(); it.ok = !!body.ok; it.pctGiven = body.ok ? it.pct : Number(body.pct) || 0;
    await S.kvSet(env, 'desk_disc', JSON.stringify(list));
    await S.addMsg(env, { gid: it.gid, dir: 'log', kind: 'CALL', body: body.ok ? `🎁 Admin ने ${it.pct}% सूट मंजूर केली (${it.by} साठी).` : `🎁 Admin: ${it.pct}% नाही${it.pctGiven ? ', ' + it.pctGiven + '% द्या' : ''}.` });
    return json({ success: true, data: it });
  }
  if (seg === 'rules') {
    const b = body || {};
    const cur = await rules(env, S.kvGet), num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
    const next = {
      daySize: num(b.daySize, 5, 150, cur.daySize), newMin: num(b.newMin, 5, 240, cur.newMin), talkDays: num(b.talkDays, 1, 14, cur.talkDays),
      noAnswerMax: num(b.noAnswerMax, 1, 10, cur.noAnswerMax), payingCheckH: num(b.payingCheckH, 8, 21, cur.payingCheckH), renewDays: num(b.renewDays, 1, 15, cur.renewDays),
      lockMin: num(b.lockMin, 5, 120, cur.lockMin),
      hours: Array.isArray(b.hours) && b.hours.length === 2 ? [num(b.hours[0], 6, 22, cur.hours[0]), num(b.hours[1], 7, 23, cur.hours[1])] : cur.hours,
      staffDisc: Array.isArray(b.staffDisc) ? b.staffDisc.map(Number).filter(n => n > 0 && n <= 90).slice(0, 4) : cur.staffDisc,
      reasons: b.reasons && typeof b.reasons === 'object' ? Object.fromEntries(['talk', 'paying', 'later', 'no'].map(k => [k, (Array.isArray(b.reasons[k]) ? b.reasons[k] : cur.reasons[k]).map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 12)])) : cur.reasons,
    };
    await S.kvSet(env, 'desk_rules', JSON.stringify(next));
    return json({ success: true, data: next });
  }
  return json({ success: false, message: 'Not found' }, 404);
}

// ── the Admin's view (GET /crm/desk/admin?day=) ──
export async function deskAdmin(env, url, ctx) {
  const { S } = ctx, now = Date.now();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : istDay();
  const from = Date.parse(day + 'T00:00:00+05:30');
  await ensure(env);
  const [{ results: acts }, { results: dayRows }, { results: leads }, { results: closes }, R] = await Promise.all([
    env.DB.prepare('SELECT by_id, by_name, action, COUNT(*) AS n FROM acts WHERE at >= ? AND at < ? GROUP BY by_id, action').bind(from, from + DAY).all(),
    env.DB.prepare("SELECT by_id, COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM desk_day WHERE day = ? GROUP BY by_id").bind(day).all(),
    env.DB.prepare("SELECT gid, crm, created_at, data FROM leads WHERE mobile IS NOT NULL AND data NOT LIKE '%\"tdemo\":{%'").all(),
    env.DB.prepare("SELECT detail, COUNT(*) AS n FROM acts WHERE action IN ('close', 'no', 'wrong') GROUP BY detail").all(),
    rules(env, S.kvGet),
  ]);
  const team = {};
  for (const a of acts || []) { const p = team[a.by_id] ||= { id: a.by_id, name: a.by_name, c: {} }; p.c[a.action] = a.n; }
  for (const d of dayRows || []) { const p = team[d.by_id] ||= { id: d.by_id, name: d.by_id, c: {} }; p.day = { total: d.total, done: d.done }; }
  // speed to the first team contact (families that came in the last 7 days) and sources → paid
  const firstTouch = new Map();
  const { results: ft } = await env.DB.prepare('SELECT gid, MIN(at) AS at FROM acts WHERE gid IS NOT NULL GROUP BY gid').all();
  for (const r of ft || []) firstTouch.set(r.gid, r.at);
  const waits = [], src = {};
  for (const r of leads || []) {
    const d = JSON.parse(r.data);
    if (r.created_at >= now - 7 * DAY && firstTouch.has(r.gid)) waits.push((firstTouch.get(r.gid) - r.created_at) / 60e3);
    const k = d.ctwaUntil ? `WhatsApp ad${d.ctwaAd ? ' · ' + d.ctwaAd : ''}` : d.via === 'form' ? 'Website नंबर' : d.desk && d.desk.source ? `Website · ${d.desk.source}` : d.via === 'wa' ? 'थेट WhatsApp' : d.imported ? 'Import' : 'इतर';
    const s = src[k] ||= { source: k, leads: 0, tested: 0, app: 0, paid: 0, rs: 0, wrong: 0 };
    s.leads++; if (d.testsDone) s.tested++; if (d.app) s.app++; if (d.paid) { s.paid++; s.rs += (d.paidInfo && d.paidInfo.amount) || (d.desk && d.desk.plan && d.desk.plan.amount) || 0; } if (d.wrongNumber || d.closed === 'नंबर चुकीचा') s.wrong++;
  }
  waits.sort((a, b) => a - b);
  const lost = {};
  for (const c of closes || []) { const k = String(c.detail || '').trim().split(' · ')[0] || '(कारण नाही)'; const key = /^n+k+o+y?$|^नको/i.test(k) ? 'फक्त "नको" (कारण नाही)' : k; lost[key] = (lost[key] || 0) + c.n; }
  let disc = []; try { disc = JSON.parse((await S.kvGet(env, 'desk_disc')) || '[]'); } catch {}
  return {
    day, rules: R,
    team: Object.values(team).map(p => ({ id: p.id, name: p.name, day: p.day || null, calls: p.c.attempt || 0, talk: p.c.talk || 0, paying: p.c.paying || 0, noanswer: p.c.noanswer || 0, wa: (p.c.wa || 0) + (p.c.reply || 0), paid: p.c.paid || 0, closed: (p.c.no || 0) + (p.c.close || 0) + (p.c.wrong || 0) })),
    speed: { n: waits.length, median_min: waits.length ? Math.round(waits[Math.floor(waits.length / 2)]) : null, within: waits.filter(w => w <= R.newMin).length, over_day: waits.filter(w => w > 1440).length },
    sources: Object.values(src).sort((a, b) => b.leads - a.leads),
    lost: Object.entries(lost).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    approvals: disc.filter(x => !x.doneAt),
    teachers: await ctx.teacherFwd(env),
  };
}
// when a payment comes in: counted for the member who last handled the family (within 7 days)
export async function creditPaid(env, act, lead, amount) {
  const lt = lead && lead.lastTeam;
  if (!lt || !lt.byId || Date.now() - ms(lt.at) > 7 * DAY) return;
  await act(env, { id: lt.byId, name: lt.by, role: 'staff' }, lead.gid, 'paid', amount ? '₹' + amount : '');
}
