// Talking to the Render backend. Render may be asleep (free tier), so anything that must happen
// (save the parent's number, register a महा-Test, send a push) goes through the `jobs` table and is
// retried by the cron with growing gaps. Reading a lead is best-effort with a short timeout.

import { nowMs } from './store.js';

async function call(env, path, init = {}, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(env.RENDER_URL + path, {
      ...init, signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': env.SHARED_SECRET, ...(init.headers || {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Render ${r.status}: ${j.message || ''}`);
    return j;
  } finally { clearTimeout(timer); }
}

// WhatsApp login (forgot PIN): Render checks the number against the account bound to the phone that asked
export async function waLogin(env, nonce, mobile) {
  try { return (await call(env, '/api/guest/bot/wa-login', { method: 'POST', body: JSON.stringify({ nonce, mobile }) }, 25000)).data || null; }
  catch { return null; }
}

// a family that wrote first: Render makes (or finds by the number) its lead → { gid, …the facts }, or null
export async function newLead(env, body) {
  try { return (await call(env, '/api/guest/bot/action', { method: 'POST', body: JSON.stringify({ ...body, action: 'new_lead' }) }, 20000)).data || null; }
  catch { return null; }
}
// keep Render awake (its free plan sleeps after 15 idle minutes)
export async function ping(env) {
  try { await fetch(env.RENDER_URL + '/api/health', { signal: AbortSignal.timeout(60000) }); } catch { /* asleep: the next one wakes it */ }
}

// the facts the rules need about a child (name, class, free tests, prices, next महा-Test…), or null
// how much the children use the app: { gid: { last (ms), tests, min7 } } (best effort; {} when Render is asleep)
export async function appUsage(env, gids) {
  if (!gids.length) return {};
  try { return (await call(env, '/api/guest/bot/usage', { method: 'POST', body: JSON.stringify({ gids }) }, 8000)).data || {}; }
  catch { return {}; }
}

export async function leadInfo(env, gid) {
  try { return (await call(env, `/api/guest/bot/lead/${encodeURIComponent(gid)}`, {}, 6000)).data || null; }
  catch { return null; }
}

export const queue = (env, gid, action, body) => env.DB.prepare(
  'INSERT INTO jobs (gid, action, body, next_at) VALUES (?, ?, ?, ?)'
).bind(gid || null, action, JSON.stringify(body || {}), nowMs()).run();

// run due jobs (from the cron); a job that keeps failing waits 1, 2, 4 … min, and is dropped after 12 tries (~2 days)
export async function runJobs(env, limit = 10) {
  const { results } = await env.DB.prepare('SELECT * FROM jobs WHERE next_at <= ? ORDER BY next_at, id LIMIT ?').bind(nowMs(), limit).all();
  let done = 0;
  for (const j of results || []) {
    try {
      await call(env, '/api/guest/bot/action', { method: 'POST', body: JSON.stringify({ gid: j.gid, action: j.action, ...JSON.parse(j.body) }) });
      await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(j.id).run();
      done++;
    } catch (e) {
      const tries = j.tries + 1;
      if (tries >= 12) await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(j.id).run();
      else await env.DB.prepare('UPDATE jobs SET tries = ?, next_at = ?, last_error = ? WHERE id = ?').bind(tries, nowMs() + 60e3 * 2 ** (tries - 1), String(e.message).slice(0, 200), j.id).run();
    }
  }
  return done;
}
