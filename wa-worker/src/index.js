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
import { leadInfo, queue, runJobs } from './render.js';

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
      await queue(env, gid, o.action, { mobile, name: o.name || '' });
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
  const code = (text.toUpperCase().match(/\b([0-9A-F]{10})\b/) || [])[1];
  if (code) await S.setPhone(env, mobile, code);
  const gid = code || await S.phoneGid(env, mobile);
  if (!gid) {
    // an unknown number without a code ("hi"): they wrote first, so a free welcome with the free test link
    await S.addMsg(env, { mobile, dir: 'in', body: text || `[${m.type}]` });
    if (env.BOT_OFF === '1') return;
    const body = `नमस्कार 🙏 NKs EduOrbit.\nपाल्याची free test (10 मिनिटं, login नाही) 👇\n${WA.CONFIG.site}/student-app/?free=1\nTest दिली की result इथेच मिळेल.`;
    for (const b of bodiesFor('91' + mobile, body, [])) { const id = await post(env, b); await S.addMsg(env, { mobile, dir: 'out', kind: 'service', body, wa_id: id, status: 'sent' }); }
    return;
  }
  await withLead(env, gid, mobile, async (lead, now) => {
    await S.addMsg(env, { gid, mobile, dir: 'in', body: text || `[${m.type}]`, wa_id: m.id });
    // a photo / voice note: the window opens anyway; tell them what works
    return WA.inbound(lead, text || '?', now);
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

const LISTS = ['hot', 'cold', 'form', 'call', 'later', 'paid', 'closed'];
async function crm(env, req, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // crm, …
  if (parts[1] === 'summary' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT crm, COUNT(*) AS n FROM leads GROUP BY crm').all();
    const counts = {}; for (const r of results || []) counts[r.crm || 'active'] = r.n;
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
  if (parts[1] === 'list' && req.method === 'GET') {
    const list = url.searchParams.get('list') || 'all', q = (url.searchParams.get('q') || '').trim();
    const off = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const where = [], args = [];
    if (LISTS.includes(list)) { where.push('crm = ?'); args.push(list); }
    else if (list === 'active') where.push('crm IS NULL');
    else if (list === 'nextyear') { where.push("crm = 'closed' AND revisit_at IS NOT NULL AND revisit_at <= ?"); args.push(Date.now()); }
    if (q) { where.push('(name LIKE ? OR mobile LIKE ? OR gid LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q.toUpperCase()}%`); }
    const sql = `SELECT gid, name, cls, mobile, crm, last_in, updated_at, data FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 50 OFFSET ?`;
    const { results } = await env.DB.prepare(sql).bind(...args, off).all();
    const now = new Date();
    return json({ success: true, data: (results || []).map(r => {
      const d = JSON.parse(r.data);
      return { gid: r.gid, name: r.name, cls: r.cls, mobile: r.mobile, crm: r.crm, last_in: r.last_in, updated_at: r.updated_at,
        tests: d.testsDone, free_total: d.freeTotal, via: d.via, app: d.app, paid: d.paid, daily: d.daily, closed: d.closed, revisit_at: d.revisitAt, open: WA.isOpen(d, now) };
    }) });
  }
  if (parts[1] === 'lead' && GID.test(parts[2] || '')) {
    const gid = parts[2];
    if (req.method === 'GET' && !parts[3]) {
      const lead = await S.getLead(env, gid);
      if (!lead) return json({ success: false, message: 'Lead नाही' }, 404);
      const { results } = await env.DB.prepare('SELECT dir, kind, cost, body, status, at FROM msgs WHERE gid = ? ORDER BY at DESC, id DESC LIMIT 300').bind(gid).all();
      return json({ success: true, data: { lead, open: WA.isOpen(lead, new Date()), msgs: (results || []).reverse() } });
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
        const r = await withLead(env, gid, b.mobile ? String(b.mobile).slice(-10) : null, (lead, now) => {
          const out = [];
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
  },
};
