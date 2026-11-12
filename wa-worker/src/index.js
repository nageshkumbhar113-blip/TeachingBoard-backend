// NKs EduOrbit WhatsApp bot + CRM API — Cloudflare Worker.
//   GET  /webhook              Meta's one-time webhook check
//   POST /webhook              parents' messages and delivery statuses (signed by Meta)
//   POST /event                Render: test done / paid / app install / form number / महा-Test result / sync
//   POST /tick                 run the schedule now (X-Bot-Key; the cron does this every 10 min)
//   /crm/…                     Admin › CRM (Bearer token signed by Render)
// The rules are all in waFlow.js; this file only stores, sends and routes.

import WA from './waFlow.js';
import { validSignature, bodiesFor, templateBody, post, inboundText, hmacHex, sameHex } from './meta.js';
import * as S from './store.js';
import { leadInfo, queue, runJobs, waLogin, newLead, ping } from './render.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bot-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const GID = /^[0-9A-F]{10}$/;

function configure(env) {
  if (env.BOT_NUMBER) WA.CONFIG.botNumber = env.BOT_NUMBER;
  if (env.TEAM_NUMBER) WA.CONFIG.teamNumber = env.TEAM_NUMBER;
  if (env.SITE) WA.CONFIG.site = env.SITE;
}
const keyOk = (env, req) => !!env.SHARED_SECRET && sameHex(req.headers.get('X-Bot-Key') || '', env.SHARED_SECRET);

// ── one lead, changed by one thing at a time ──
async function withLead(env, gid, mobile, fn) {
  const now = new Date();
  let lead = await S.getLead(env, gid);
  if (!lead) {
    lead = WA.createLead({ gid }, now);
    const info = await leadInfo(env, gid);
    if (info) { WA.event(lead, 'sync', info, now); lead.syncedAt = now.toISOString(); }
    await S.ensureRow(env, lead);
  }
  if (!(await S.lock(env, gid))) throw new Error('lead busy: ' + gid);
  try {
    lead = (await S.getLead(env, gid)) || lead;
    if (mobile) lead.mobile = mobile;
    // refresh the facts from Render now and then (best effort; Render may be asleep)
    if (!lead.syncedAt || now - new Date(lead.syncedAt) > 6 * 3600e3) {
      const info = await leadInfo(env, gid);
      if (info) WA.event(lead, 'sync', info, now);
      lead.syncedAt = now.toISOString();
    }
    const outs = (await fn(lead, now)) || [];
    const res = await deliver(env, lead, outs);
    await S.saveLead(env, lead, WA.nextDue(lead, now));
    return res;
  } finally { await S.unlock(env, gid); }
}

// ── carry out what the rules returned ──
async function deliver(env, lead, outs) {
  const team = [], gid = lead.gid, mobile = lead.mobile || null;
  for (const o of outs) {
    if (o.to === 'log') { await S.addMsg(env, { gid, mobile, dir: 'log', kind: o.tag, body: o.text }); continue; }
    if (o.to === 'team') { team.push({ text: o.text, waMe: o.waMe }); await S.addMsg(env, { gid, mobile, dir: 'team', body: o.text }); continue; }
    if (o.to === 'push' || o.to === 'app') {
      await queue(env, gid, o.to === 'push' ? 'push' : 'app_msg', { text: o.text, buttons: o.buttons });
      await S.addMsg(env, { gid, mobile, dir: o.to, body: o.text });
      continue;
    }
    if (o.to === 'do') {
      await queue(env, gid, o.action, { mobile, name: o.name || '', ...(o.data || {}) });
      await S.addMsg(env, { gid, mobile, dir: 'do', kind: o.action, body: o.name || '' });
      continue;
    }
    if (o.to !== 'wa') continue;
    if (!mobile) { await S.addMsg(env, { gid, dir: 'log', kind: 'NO_NUMBER', body: o.text }); continue; }
    if (env.BOT_OFF === '1') { await S.addMsg(env, { gid, mobile, dir: 'log', kind: 'BOT_OFF', body: o.text }); continue; }
    const to = '91' + mobile;
    try {
      if (o.kind === 'service') {
        for (const b of bodiesFor(to, o.text, o.buttons)) {
          const id = await post(env, b);
          await S.addMsg(env, { gid, mobile, dir: 'out', kind: 'service', body: b.type === 'text' ? b.text.body : JSON.stringify(b.interactive), wa_id: id, status: 'sent' });
        }
      } else {
        // a paid template: only by hand (Admin) — capped per day, and only with an approved template
        const cap = Number(env.DAILY_CAP_RS) || 0;
        if ((await S.todayCost(env)) + (o.cost || 0) > cap) { await S.addMsg(env, { gid, mobile, dir: 'log', kind: 'CAP', body: `आजची ₹${cap} मर्यादा पूर्ण → template पाठवला नाही.` }); continue; }
        if (!env.REENGAGE_TEMPLATE) { await S.addMsg(env, { gid, mobile, dir: 'log', kind: 'NO_TEMPLATE', body: 'Meta ने मंजूर केलेला template नाव (REENGAGE_TEMPLATE) अजून ठेवलेला नाही.' }); continue; }
        const id = await post(env, templateBody(to, env.REENGAGE_TEMPLATE, env.TEMPLATE_LANG, lead.name));
        await S.addCost(env, o.cost || 0);
        await S.addMsg(env, { gid, mobile, dir: 'out', kind: o.kind, cost: o.cost || 0, body: o.text, wa_id: id, status: 'sent' });
      }
    } catch (e) {
      await S.addMsg(env, { gid, mobile, dir: 'log', kind: 'SEND_ERROR', body: String(e.message).slice(0, 300) });
    }
  }
  return { team };
}

// ── Meta webhook ──
async function onWebhook(env, payload) {
  await S.kvSet(env, 'last_webhook', Date.now());
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const st of v.statuses || []) {
      await env.DB.prepare('UPDATE msgs SET status = ? WHERE wa_id = ?').bind(st.status, st.id).run();
      if (st.status === 'failed') await S.addMsg(env, { dir: 'log', kind: 'FAILED', body: JSON.stringify(st.errors || []).slice(0, 300), wa_id: st.id });
    }
    for (const m of v.messages || []) {
      try { await onMessage(env, m); }
      catch (e) { await S.addMsg(env, { dir: 'log', kind: 'ERROR', body: String(e.message).slice(0, 300), wa_id: m.id }); }
    }
  }
}
async function onMessage(env, m) {
  if (!m.id || !(await S.firstSeen(env, m.id))) return;            // the same message again
  const mobile = String(m.from || '').replace(/\D/g, '').slice(-10);
  if (!/^\d{10}$/.test(mobile)) return;
  const text = inboundText(m).trim();
  // "LOGIN <one-time code>" from the app's "WhatsApp ने login": not a lead message
  const login = text.match(/^LOGIN\s+([0-9a-f]{24})$/i);
  if (login) {
    await S.addMsg(env, { mobile, dir: 'in', body: 'LOGIN …', wa_id: m.id });
    const r = await waLogin(env, login[1].toLowerCase(), mobile);
    const names = (r?.names || []).join(', ');
    const reply = !r ? '⏳ आत्ता तपासता आलं नाही. 1 मिनिटाने पुन्हा Send करा.'
      : r.status === 'ok' ? `✅ ${names}: नंबर पक्का झाला. आता app मध्ये परत जा आणि नवीन PIN ठेवा (10 मिनिटांत).`
      : r.status === 'other_device' ? '📱 हे account दुसऱ्या phone वर जोडलेलं आहे. त्याच phone वरून करा, किंवा app मधल्या मदत मधून Admin ला request पाठवा.'
      : r.status === 'no_match' ? '❌ हा WhatsApp नंबर कोणत्याही विद्यार्थ्याच्या account शी जोडलेला नाही. Register करताना दिलेल्या पालकांच्या नंबरवरून पाठवा.'
      : '⌛ वेळ संपली. App मध्ये पुन्हा "WhatsApp ने login" दाबा.';
    if (env.BOT_OFF !== '1') for (const b of bodiesFor('91' + mobile, reply, [])) { const id = await post(env, b); await S.addMsg(env, { mobile, dir: 'out', kind: 'service', body: reply, wa_id: id, status: 'sent' }); }
    return;
  }
  const code = (text.toUpperCase().match(/\b([0-9A-F]{10})\b/) || [])[1];
  if (code) await S.setPhone(env, mobile, code);
  const gid = code || await S.phoneGid(env, mobile);
  if (!gid) {
    // a number the bot does not know, without a code: a click-to-WhatsApp ad (m.referral), or just "hi"
    if (env.BOT_OFF === '1') { await S.addMsg(env, { mobile, dir: 'in', body: text || `[${m.type}]` }); return; }
    await newFamily(env, m, mobile, text);
  } else {
    await withLead(env, gid, mobile, async (lead, now) => {
      await S.addMsg(env, { gid, mobile, dir: 'in', body: text || `[${m.type}]`, wa_id: m.id });
      // a photo / voice note: the window opens anyway; tell them what works
      return WA.inbound(lead, text || '?', now);
    });
  }
  // what the message asked Render to do (the child's name → the free account, the class…): now, not at the next cron
  await runJobs(env, 5).catch(() => {});
}

// ── a new family on WhatsApp: Render makes the lead (the same one if this number came from the website), the bot
// asks the class (if the ad does not say it) and the child's name. From an ad: the free window is 72 h ──
const newGid = () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
async function newFamily(env, m, mobile, text) {
  const ref = m.referral && (m.referral.source_type === 'ad' || m.referral.source_id) ? m.referral : null;
  const now = new Date();
  const body = { mobile, text: String(text || '').slice(0, 200), ad_id: ref ? String(ref.source_id || '').slice(0, 30) : '',
    headline: ref ? String(ref.headline || '').slice(0, 120) : '', ad_body: ref ? String(ref.body || '').slice(0, 300) : '' };
  let gid = newGid();
  const info = await newLead(env, { gid, ...body });   // Render asleep → null: the job below makes it later
  if (info && GID.test(info.gid || '')) gid = info.gid;
  else await queue(env, gid, 'new_lead', { ...body, queued: true });   // Render tells the bot the facts when it makes it
  await S.setPhone(env, mobile, gid);
  if (!(await S.getLead(env, gid))) {
    const lead = WA.createLead({ gid, source: ref ? 'ctwa' : 'wa' }, now);
    lead.mobile = mobile;
    if (ref) { lead.ctwaUntil = new Date(now.getTime() + WA.CONFIG.ctwaHours * 3600e3).toISOString(); lead.ctwaAd = body.ad_id; }
    if (info) { WA.event(lead, 'sync', info, now); lead.syncedAt = now.toISOString(); }
    await S.ensureRow(env, lead);
    await withLead(env, gid, mobile, async (l, t) => {
      await S.addMsg(env, { gid, mobile, dir: 'in', body: (ref ? '📣 Ad: ' : '') + (text || `[${m.type}]`), wa_id: m.id });
      return WA.welcome(l, text, t);
    });
    return;
  }
  // a family already known here (Render matched the number to an older lead): the usual conversation
  await withLead(env, gid, mobile, async (l, t) => {
    await S.addMsg(env, { gid, mobile, dir: 'in', body: text || `[${m.type}]`, wa_id: m.id });
    if (ref && !l.ctwaUntil) l.ctwaUntil = new Date(t.getTime() + WA.CONFIG.ctwaHours * 3600e3).toISOString();
    return WA.inbound(l, text || '?', t);
  });
}

// ── the schedule ──
async function tickOne(env, gid) {
  return withLead(env, gid, null, (lead, now) => WA.tick(lead, now));
}
async function runTick(env) {
  await S.kvSet(env, 'last_tick', Date.now());
  const { results } = await env.DB.prepare('SELECT gid FROM leads WHERE next_due IS NOT NULL AND next_due <= ? ORDER BY next_due LIMIT 40').bind(Date.now()).all();
  let n = 0;
  for (const r of results || []) {
    try {
      // a separate invocation per lead (own CPU budget on the free plan) when the self binding exists
      if (env.SELF) await env.SELF.fetch(`https://self/tick-one?gid=${r.gid}`, { method: 'POST', headers: { 'X-Bot-Key': env.SHARED_SECRET } });
      else await tickOne(env, r.gid);
      n++;
    } catch (e) { await S.addMsg(env, { gid: r.gid, dir: 'log', kind: 'TICK_ERROR', body: String(e.message).slice(0, 300) }); }
  }
  const jobs = await runJobs(env);
  // keep the tables small: delivered-ids older than 7 days, chat older than 120 days
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM seen WHERE at < ?').bind(Date.now() - 7 * 864e5).run();
    await env.DB.prepare('DELETE FROM msgs WHERE at < ?').bind(Date.now() - 120 * 864e5).run();
  }
  return { leads: n, jobs };
}

// ── Admin token: "<base64url payload>.<hex HMAC>" made by Render with the shared secret ──
async function adminOk(env, req) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const [p, sig] = tok.split('.');
  if (!p || !sig || !env.SHARED_SECRET) return false;
  if (!sameHex(sig, await hmacHex(env.SHARED_SECRET, p))) return false;
  try { const o = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))); return o.role === 'admin' && o.exp > Date.now(); }
  catch { return false; }
}

const LISTS = ['hot', 'cold', 'form', 'call', 'later', 'paid', 'closed', 'import'];
// Admin's labels (like WhatsApp Business lists): [{ id, name, color }] in kv 'labels'
const LABEL_COLORS = ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#a16207', '#475569'];
async function getLabels(env) { try { return JSON.parse((await S.kvGet(env, 'labels')) || '[]'); } catch { return []; } }
async function labelIdFor(env, name) {
  const n = String(name || '').trim().slice(0, 40); if (!n) return null;
  const all = await getLabels(env);
  const hit = all.find(l => l.name.toLowerCase() === n.toLowerCase());
  if (hit) return hit.id;
  const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  all.push({ id, name: n, color: LABEL_COLORS[all.length % LABEL_COLORS.length] });
  await S.kvSet(env, 'labels', JSON.stringify(all));
  return id;
}
// ☀️ call these first (Sunday): not paid, not closed, and the offer still running or a महा-Test in the last 3 days;
// the offer ending soonest on top, then the महा-Test takers
async function callFirst(env) {
  const { results } = await env.DB.prepare("SELECT gid, name, cls, mobile, crm, last_in, updated_at, data FROM leads WHERE crm IS NULL OR crm NOT IN ('paid', 'closed') ORDER BY updated_at DESC LIMIT 500").all();
  const now = new Date(), t = now.getTime();
  const rows = [];
  for (const r of results || []) {
    const d = JSON.parse(r.data);
    if (d.paid || d.closed || !r.mobile) continue;
    const offer = d.offerEnd && new Date(d.offerEnd).getTime() > t ? new Date(d.offerEnd).getTime() : 0;
    const mt = d.mtLast && t - new Date(d.mtLast.at).getTime() < 3 * 864e5 ? d.mtLast : null;
    // gave the number but no test yet (the last 7 days): call them too, after the running offers
    const noTest = !offer && !mt && !d.testsDone && !d.app && r.crm !== 'import' && d.createdAt && t - new Date(d.createdAt).getTime() < 7 * 864e5;
    if (!offer && !mt && !noTest) continue;
    rows.push({ gid: r.gid, name: r.name, cls: r.cls, mobile: r.mobile, crm: r.crm, last_in: r.last_in, updated_at: r.updated_at,
      tests: d.testsDone, free_total: d.freeTotal, via: d.via, app: d.app, paid: d.paid, closed: d.closed, open: WA.isOpen(d, now),
      offer_end: offer ? d.offerEnd : null, offer: offerOf(d, now), mt, no_test: noTest, acct: !!(d.acct && d.acct.code), push_on: !!d.pushOn, _k: offer || (mt ? 9e15 : 9.5e15) });
  }
  return rows.sort((a, b) => a._k - b._k).slice(0, 100).map(({ _k, ...r }) => r);
}
// the first-payment offer right now: { pct, end } or null (50 % for 24 h, then 30 % until Sunday night)
const offerOf = (d, now) => { const o = d.paid ? null : WA.offerNow(d, now); return o ? { pct: o.pct, end: o.end.toISOString() } : null; };
// ── 📋 follow-up steps ──
const FU_DEFAULT = [
  { name: 'पहिला संपर्क', color: '#e11d48', tpl: 'hello', wait: 1 },
  { name: 'Test आठवण', color: '#ea580c', tpl: 'remind', wait: 2 },
  { name: 'Result / सवलत', color: '#ca8a04', tpl: 'result', wait: 1 },
  { name: 'App Code + PIN', color: '#7c3aed', tpl: 'acct', wait: 2 },
  { name: 'पूर्ण course', color: '#2563eb', tpl: 'course', wait: 3 },
  { name: 'शेवटचा call', color: '#64748b', tpl: 'missed', wait: 0 },
];
async function fuSteps(env) { try { const s = JSON.parse((await S.kvGet(env, 'fu_steps')) || 'null'); return Array.isArray(s) && s.length ? s : FU_DEFAULT; } catch { return FU_DEFAULT; } }
const IST_MS = 5.5 * 3600e3;
const endOfToday = (t = Date.now()) => { const d = new Date(t + IST_MS); d.setUTCHours(23, 59, 59, 999); return d.getTime() - IST_MS; };
// where this family stands now: { step (1-based), due (ms) } — or null (not in the follow-up)
function fuOf(r, d, now, steps) {
  if (!r.mobile || d.paid || d.closed || (d.fu && d.fu.done)) return null;
  if (WA.isOpen(d, now)) return null;                         // talking to the bot right now: the bot does the work
  const f = d.fu ? { ...d.fu } : { step: 1, due: Date.parse(d.createdAt || '') || 0 };
  const at = name => steps.findIndex(s => s.tpl === name) + 1;   // a step by its message (0 = not in the list)
  const result = at('result'), app = at('acct');
  // what the family did, or the bot already sent, moves it on (never back)
  if (d.testsDone && result && f.step < result) { f.step = result; f.due = now.getTime(); }
  if (d.testsDone && d.lastInboundAt && result && f.step === result && (!d.fu || Date.parse(d.lastInboundAt) > (d.fu.setAt || 0))) { f.step = result + 1; f.due = now.getTime(); }
  if ((d.app || d.appAsked) && app && f.step === app) { f.step = app + 1; f.due = now.getTime(); }
  if (f.step > steps.length) return null;
  return f;
}
async function fuRows(env, now) {
  const steps = await fuSteps(env);
  const { results } = await env.DB.prepare("SELECT gid, name, cls, mobile, crm, last_in, updated_at, data FROM leads WHERE mobile IS NOT NULL AND (crm IS NULL OR crm NOT IN ('paid', 'closed')) ORDER BY updated_at DESC LIMIT 3000").all();
  const rows = [];
  for (const r of results || []) {
    const d = JSON.parse(r.data), f = fuOf(r, d, now, steps);
    if (!f) continue;
    rows.push({ gid: r.gid, name: r.name, cls: r.cls, mobile: r.mobile, crm: r.crm, last_in: r.last_in, updated_at: r.updated_at,
      tests: d.testsDone, free_total: d.freeTotal, app: d.app, acct: !!(d.acct && d.acct.code), labels: d.labels || [], place: d.place || '', sent: d.teamSent || 0,
      offer: offerOf(d, now), fu_step: f.step, fu_due: f.due });
  }
  return { steps, rows };
}

// 📲 the free account exists (code + PIN) but the app is not in use yet: call and help install
async function noApp(env) {
  const { results } = await env.DB.prepare("SELECT gid, name, cls, mobile, crm, last_in, updated_at, data FROM leads WHERE crm IS NULL OR crm NOT IN ('paid', 'closed') ORDER BY updated_at DESC LIMIT 500").all();
  const rows = [], now = new Date();
  for (const r of results || []) {
    const d = JSON.parse(r.data);
    if (d.paid || d.closed || d.app || !r.mobile || !(d.acct && d.acct.code)) continue;
    rows.push({ gid: r.gid, name: r.name, cls: r.cls, mobile: r.mobile, crm: r.crm, last_in: r.last_in, updated_at: r.updated_at,
      tests: d.testsDone, free_total: d.freeTotal, via: d.via, app: false, open: WA.isOpen(d, now), offer: offerOf(d, now), acct: true });
  }
  return rows.slice(0, 100);
}
async function crm(env, req, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // crm, …
  if (parts[1] === 'summary' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT crm, COUNT(*) AS n FROM leads GROUP BY crm').all();
    const counts = {}; for (const r of results || []) counts[r.crm || 'active'] = r.n;
    counts.first = (await callFirst(env)).length;
    counts.noapp = (await noApp(env)).length;
    counts.team_today = Number(await S.kvGet(env, 'teamwa:' + S.istDay())) || 0;
    counts.nextyear = (await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE crm = 'closed' AND revisit_at IS NOT NULL AND revisit_at <= ?").bind(Date.now()).first()).n;
    const month = S.istDay().slice(0, 7);
    const mc = await env.DB.prepare("SELECT SUM(CAST(v AS REAL)) AS s FROM kv WHERE k LIKE ?").bind('cost:' + month + '%').first();
    const jobs = (await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n;
    return json({ success: true, data: {
      counts, cost_today: await S.todayCost(env), cost_month: mc?.s || 0, cap: Number(env.DAILY_CAP_RS) || 0,
      last_tick: Number(await S.kvGet(env, 'last_tick')) || null, last_webhook: Number(await S.kvGet(env, 'last_webhook')) || null,
      bot_off: env.BOT_OFF === '1', jobs, bot_number: WA.CONFIG.botNumber,
    } });
  }
  if (parts[1] === 'list' && req.method === 'GET' && url.searchParams.get('list') === 'first') return json({ success: true, data: await callFirst(env) });
  if (parts[1] === 'list' && req.method === 'GET' && url.searchParams.get('list') === 'noapp') return json({ success: true, data: await noApp(env) });
  if (parts[1] === 'list' && req.method === 'GET') {
    const list = url.searchParams.get('list') || 'all', q = (url.searchParams.get('q') || '').trim();
    const off = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const where = [], args = [];
    if (LISTS.includes(list)) { where.push('crm = ?'); args.push(list); }
    else if (list === 'active') where.push('crm IS NULL');
    else if (list === 'nextyear') { where.push("crm = 'closed' AND revisit_at IS NOT NULL AND revisit_at <= ?"); args.push(Date.now()); }
    if (q) { where.push('(name LIKE ? OR mobile LIKE ? OR gid LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q.toUpperCase()}%`); }
    const lab = String(url.searchParams.get('label') || '');
    if (/^l[a-z0-9]{3,20}$/.test(lab)) { where.push('data LIKE ?'); args.push(`%"${lab}"%`); }
    const sql = `SELECT gid, name, cls, mobile, crm, last_in, updated_at, data FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 50 OFFSET ?`;
    const { results } = await env.DB.prepare(sql).bind(...args, off).all();
    const now = new Date();
    return json({ success: true, data: (results || []).map(r => {
      const d = JSON.parse(r.data);
      return { gid: r.gid, name: r.name, cls: r.cls, mobile: r.mobile, crm: r.crm, last_in: r.last_in, updated_at: r.updated_at,
        tests: d.testsDone, free_total: d.freeTotal, via: d.via, app: d.app, paid: d.paid, daily: d.daily, closed: d.closed, revisit_at: d.revisitAt, open: WA.isOpen(d, now),
        offer: offerOf(d, now), mt: d.mtLast || null, acct: !!(d.acct && d.acct.code), push_on: !!d.pushOn, labels: d.labels || [], place: d.place || '', sent: d.teamSent || 0 };
    }) });
  }
  // 📋 follow-up: the steps with their counts (all / due today), one step's families, the steps' settings
  if (parts[1] === 'fu' && !parts[2] && req.method === 'GET') {
    const now = new Date(), { steps, rows } = await fuRows(env, now), end = endOfToday();
    return json({ success: true, data: { steps, counts: steps.map((s, i) => ({ step: i + 1, total: rows.filter(r => r.fu_step === i + 1).length, due: rows.filter(r => r.fu_step === i + 1 && r.fu_due <= end).length })) } });
  }
  if (parts[1] === 'fu' && parts[2] === 'list' && req.method === 'GET') {
    const now = new Date(), { rows } = await fuRows(env, now), end = endOfToday();
    const step = Number(url.searchParams.get('step')) || 1, dueOnly = url.searchParams.get('due') === '1';
    return json({ success: true, data: rows.filter(r => r.fu_step === step && (!dueOnly || r.fu_due <= end)).sort((a, b) => a.fu_due - b.fu_due).slice(0, 300) });
  }
  if (parts[1] === 'fu' && parts[2] === 'steps' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const list = (Array.isArray(body.steps) ? body.steps : []).slice(0, 12).map((s, i) => ({
      name: String(s.name || '').trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : LABEL_COLORS[i % LABEL_COLORS.length],
      tpl: String(s.tpl || '').slice(0, 30), wait: Math.max(0, Math.min(30, Number(s.wait) || 0)),
    })).filter(s => s.name && s.tpl);
    await S.kvSet(env, 'fu_steps', JSON.stringify(list.length ? list : FU_DEFAULT));
    return json({ success: true, data: list.length ? list : FU_DEFAULT });
  }
  if (parts[1] === 'labels' && req.method === 'GET') return json({ success: true, data: await getLabels(env) });
  if (parts[1] === 'labels' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const list = (Array.isArray(body.labels) ? body.labels : []).slice(0, 40).map((l, i) => ({
      id: /^l[a-z0-9]{3,20}$/.test(l.id || '') ? l.id : 'l' + Date.now().toString(36) + i,
      name: String(l.name || '').trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : LABEL_COLORS[i % LABEL_COLORS.length],
    })).filter(l => l.name);
    await S.kvSet(env, 'labels', JSON.stringify(list));
    return json({ success: true, data: list });
  }
  if (parts[1] === 'templates' && req.method === 'GET') { let t = null; try { t = JSON.parse((await S.kvGet(env, 'templates')) || 'null'); } catch {} return json({ success: true, data: t }); }
  if (parts[1] === 'templates' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const list = Array.isArray(body.templates) ? body.templates.slice(0, 30).map(t => ({ id: String(t.id || '').slice(0, 30), title: String(t.title || '').slice(0, 60), when: String(t.when || '').slice(0, 80), text: String(t.text || '').slice(0, 1500) })).filter(t => t.title && t.text) : null;
    await S.kvSet(env, 'templates', JSON.stringify(list));
    return json({ success: true, data: list });
  }
  if (parts[1] === 'label-stats' && req.method === 'GET') {
    const lab = String(url.searchParams.get('label') || '');
    if (!/^l[a-z0-9]{3,20}$/.test(lab)) return json({ success: false }, 400);
    const { results } = await env.DB.prepare('SELECT crm, data FROM leads WHERE data LIKE ?').bind(`%"${lab}"%`).all();
    const s = { total: 0, sent: 0, replied: 0, tested: 0, app: 0, paid: 0 };
    for (const r of results || []) { const d = JSON.parse(r.data); s.total++; if (d.teamSent) s.sent++; if (d.lastInboundAt) s.replied++; if (d.testsDone) s.tested++; if (d.app) s.app++; if (d.paid) s.paid++; }
    return json({ success: true, data: s });
  }
  if (parts[1] === 'lead' && GID.test(parts[2] || '')) {
    const gid = parts[2];
    if (req.method === 'GET' && !parts[3]) {
      const lead = await S.getLead(env, gid);
      if (!lead) return json({ success: false, message: 'Lead नाही' }, 404);
      const { results } = await env.DB.prepare('SELECT dir, kind, cost, body, status, at FROM msgs WHERE gid = ? ORDER BY at DESC, id DESC LIMIT 300').bind(gid).all();
      const steps = await fuSteps(env);
      return json({ success: true, data: { lead, offer: offerOf(lead, new Date()), open: WA.isOpen(lead, new Date()), msgs: (results || []).reverse(), fu: fuOf({ mobile: lead.mobile }, lead, new Date(), steps), fu_steps: steps } });
    }
    if (req.method !== 'POST') return json({ success: false }, 405);
    const body = await req.json().catch(() => ({}));
    if (!(await S.getLead(env, gid))) return json({ success: false, message: 'Lead नाही' }, 404);
    if (parts[3] === 'call') {
      if (!['will_pay', 'later', 'not_interested'].includes(body.result)) return json({ success: false, message: 'result?' }, 400);
      const r = await withLead(env, gid, null, (lead, now) => WA.event(lead, 'call', { result: body.result, reason: String(body.reason || '').slice(0, 60), at: String(body.at || '').slice(0, 30) }, now));
      return json({ success: true, data: r });
    }
    if (parts[3] === 'team') return json({ success: true, data: await withLead(env, gid, null, (lead, now) => WA.event(lead, 'manual_wa', { text: body.text ? String(body.text).slice(0, 1000) : '' }, now)) });
    if (parts[3] === 'bot-template') return json({ success: true, data: await withLead(env, gid, null, (lead, now) => WA.event(lead, 'manual_wa', { via: 'bot' }, now)) });
    if (parts[3] === 'reply') {
      // the team answers inside the bot chat — only while the window is open (free)
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return json({ success: false, message: 'मजकूर लिहा' }, 400);
      let closed = false;
      await withLead(env, gid, null, (lead, now) => { if (!WA.isOpen(lead, now)) { closed = true; return []; } return [{ to: 'wa', kind: 'service', cost: 0, text, buttons: [] }]; });
      return closed ? json({ success: false, message: 'खिडकी बंद आहे — टीमच्या WhatsApp वरून पाठवा.' }, 409) : json({ success: true });
    }
    if (parts[3] === 'labels') {
      const ids = (Array.isArray(body.labels) ? body.labels : []).filter(x => /^l[a-z0-9]{3,20}$/.test(x)).slice(0, 20);
      await withLead(env, gid, null, lead => { lead.labels = ids; return []; });
      return json({ success: true });
    }
    // the team opened WhatsApp / SMS with a ready message (from its own phone): counted, noted in the chat
    if (parts[3] === 'sent') {
      const via = body.via === 'sms' ? 'SMS' : 'WhatsApp', tpl = String(body.tpl || '').slice(0, 60);
      const steps = await fuSteps(env);
      let moved = '';
      await withLead(env, gid, null, (lead, now) => {
        lead.teamSent = (lead.teamSent || 0) + 1; lead.teamSentAt = now.toISOString();
        const f = fuOf({ mobile: lead.mobile }, lead, now, steps);
        // this step's message (or "advance" from 📤 आजचे पाठवा): on to the next step, due after this step's days
        if (f && (body.advance || (body.tpl_id && steps[f.step - 1] && steps[f.step - 1].tpl === body.tpl_id))) {
          const cur = steps[f.step - 1];
          lead.fu = f.step >= steps.length ? { step: f.step, done: true, setAt: now.getTime() } : { step: f.step + 1, due: now.getTime() + (cur.wait || 0) * 864e5, setAt: now.getTime() };
          moved = lead.fu.done ? ` → 📋 follow-up पूर्ण` : ` → 📋 Step ${lead.fu.step} (${steps[lead.fu.step - 1].name})`;
        }
        return [];
      });
      await S.addMsg(env, { gid, dir: 'team', body: `📱 टीमने ${via} उघडला: ${tpl}${moved}${body.text ? '\n' + String(body.text).slice(0, 800) : ''}` });
      if (via === 'WhatsApp') await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?1, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)").bind('teamwa:' + S.istDay()).run();
      return json({ success: true });
    }
    if (parts[3] === 'fu') {
      const steps = await fuSteps(env), t = Date.now();
      await withLead(env, gid, null, (lead, now) => {
        const f = fuOf({ mobile: lead.mobile }, lead, now, steps) || { step: 1 };
        if (body.action === 'snooze') lead.fu = { step: f.step, due: endOfToday() + 1, setAt: t };                 // tomorrow
        // ⏭ the team called / did this step by hand: on to the next one, due after this step's days
        else if (body.action === 'next') lead.fu = f.step >= steps.length ? { step: f.step, done: true, setAt: t } : { step: f.step + 1, due: t + ((steps[f.step - 1] || {}).wait || 0) * 864e5, setAt: t };
        else if (body.action === 'set') lead.fu = { step: Math.max(1, Math.min(steps.length, Number(body.step) || 1)), due: t, setAt: t };
        else if (body.action === 'done') lead.fu = { step: f.step, done: true, setAt: t };
        else if (body.action === 'restart') lead.fu = { step: 1, due: t, setAt: t };
        return [];
      });
      return json({ success: true });
    }
    if (parts[3] === 'note') { await S.addMsg(env, { gid, dir: 'log', kind: 'NOTE', body: String(body.text || '').slice(0, 500) }); return json({ success: true }); }
  }
  return json({ success: false, message: 'Not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    configure(env);
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/webhook' && req.method === 'GET') {
        const p = url.searchParams;
        if (p.get('hub.mode') === 'subscribe' && env.VERIFY_TOKEN && p.get('hub.verify_token') === env.VERIFY_TOKEN) return new Response(p.get('hub.challenge') || '', { status: 200 });
        return new Response('forbidden', { status: 403 });
      }
      if (url.pathname === '/webhook' && req.method === 'POST') {
        const raw = await req.text();
        if (!(await validSignature(env, raw, req.headers.get('X-Hub-Signature-256')))) return new Response('bad signature', { status: 401 });
        let payload; try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
        ctx.waitUntil(onWebhook(env, payload));   // answer Meta at once, work after
        return new Response('ok', { status: 200 });
      }
      if (url.pathname === '/event' && req.method === 'POST') {
        if (!keyOk(env, req)) return json({ success: false }, 401);
        const b = await req.json().catch(() => ({}));
        const gid = String(b.gid || '').toUpperCase();
        if (!GID.test(gid) || !b.type) return json({ success: false, message: 'gid / type?' }, 400);
        if (b.type === 'form_number' && b.data && b.data.label) b.data.labelId = await labelIdFor(env, b.data.label);
        let carry = null;
        if (b.type === 'form_number' && b.mobile) {
          const mob = String(b.mobile).slice(-10), old = await S.phoneGid(env, mob);
          if (!old) await S.setPhone(env, mob, gid);
          else if (old !== gid) {
            // this number talked to the bot as a new family whose class was never known: that chat goes on here
            const o = await S.getLead(env, old);
            if (o && !o.cls && !o.testsDone && !o.paid) {
              carry = { lastInboundAt: o.lastInboundAt, unanswered: o.unanswered || 0, daily: o.daily, ctwaUntil: o.ctwaUntil, welcomed: o.welcomed };
              await withLead(env, old, null, l => { l.closed = 'जोडला: ' + gid; l.stopped = true; l.crm = 'closed'; return [{ to: 'log', tag: 'MERGE', text: `याच नंबरने website वर class / नाव दिलं → बोलणं lead ${gid} मध्ये पुढे.` }]; });
              await S.setPhone(env, mob, gid);
            }
          }
        }
        const r = await withLead(env, gid, b.mobile ? String(b.mobile).slice(-10) : null, (lead, now) => {
          const out = [];
          if (carry) {
            for (const [k, v] of Object.entries(carry)) if (v != null && lead[k] == null) lead[k] = v;
            if (carry.lastInboundAt) { lead.via = 'wa'; if (lead.crm === 'form') lead.crm = null; }
            out.push({ to: 'log', tag: 'MERGE', text: 'हा पालक आधी bot शी बोलला होता (class नव्हता) → ते बोलणं इथे जोडलं.' });
          }
          if (b.sync) {
            // with a test result, the counters come from the event itself (else the first test would look like a later one)
            const sync = { ...b.sync };
            if (b.type === 'test_done') for (const k of ['firstTestAt', 'offerEnd', 'testsDone', 'last']) delete sync[k];
            out.push(...WA.event(lead, 'sync', sync, now)); lead.syncedAt = now.toISOString();
          }
          if (b.type !== 'sync') out.push(...WA.event(lead, b.type, b.data || {}, now));
          return out;
        });
        return json({ success: true, data: r });
      }
      if (url.pathname === '/tick' && req.method === 'POST') { if (!keyOk(env, req)) return json({ success: false }, 401); return json({ success: true, data: await runTick(env) }); }
      if (url.pathname === '/tick-one' && req.method === 'POST') {
        if (!keyOk(env, req)) return json({ success: false }, 401);
        const gid = url.searchParams.get('gid') || '';
        if (!GID.test(gid)) return json({ success: false }, 400);
        await tickOne(env, gid); return json({ success: true });
      }
      if (url.pathname.startsWith('/crm/')) {
        if (!(await adminOk(env, req))) return json({ success: false, message: 'Admin login हवा' }, 401);
        return await crm(env, req, url);
      }
      return json({ success: false, message: 'Not found' }, 404);
    } catch (e) {
      return json({ success: false, message: String(e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    configure(env);
    ctx.waitUntil(runTick(env));
    // keep Render (free plan, sleeps after 15 min) awake 6 am – 11 pm IST, so a parent's page and the bot never wait for it
    const h = (new Date(Date.now() + 5.5 * 3600e3)).getUTCHours();
    if (env.KEEP_AWAKE !== '0' && h >= 6 && h < 23) ctx.waitUntil(ping(env));
  },
};
