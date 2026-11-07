// D1 access: leads (with a tiny lock), the phone → child map, the message log, seen ids, jobs, kv.

export const nowMs = () => Date.now();

export async function getLead(env, gid) {
  const row = await env.DB.prepare('SELECT data FROM leads WHERE gid = ?').bind(gid).first();
  return row ? JSON.parse(row.data) : null;
}

export async function saveLead(env, lead, nextDue) {
  const t = nowMs();
  await env.DB.prepare(
    `INSERT INTO leads (gid, mobile, name, cls, data, crm, next_due, last_in, revisit_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT(gid) DO UPDATE SET mobile = ?2, name = ?3, cls = ?4, data = ?5, crm = ?6, next_due = ?7, last_in = ?8, revisit_at = ?9, updated_at = ?10`
  ).bind(
    lead.gid, lead.mobile || null, lead.name || null, lead.cls || null, JSON.stringify(lead), lead.crm || null,
    nextDue ? nextDue.getTime() : null,
    lead.lastInboundAt ? Date.parse(lead.lastInboundAt) : null,
    lead.revisitAt ? Date.parse(lead.revisitAt) : null, t
  ).run();
}

// a per-lead lock so the webhook and the cron never change one lead at the same moment.
// The row must exist; returns true when this call holds the lock (released by unlock or after 20 s).
export async function lock(env, gid) {
  for (let i = 0; i < 25; i++) {
    const t = nowMs();
    const r = await env.DB.prepare('UPDATE leads SET lock_until = ?1 WHERE gid = ?2 AND (lock_until IS NULL OR lock_until < ?3)').bind(t + 20000, gid, t).run();
    if (r.meta.changes === 1) return true;
    await new Promise(res => setTimeout(res, 200));
  }
  return false;
}
export const unlock = (env, gid) => env.DB.prepare('UPDATE leads SET lock_until = NULL WHERE gid = ?').bind(gid).run();
// make sure a row exists (so it can be locked) without touching an existing one
export const ensureRow = (env, lead) => env.DB.prepare(
  'INSERT OR IGNORE INTO leads (gid, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)'
).bind(lead.gid, JSON.stringify(lead), nowMs()).run();

export async function phoneGid(env, mobile) {
  const r = await env.DB.prepare('SELECT gid FROM phones WHERE mobile = ?').bind(mobile).first();
  return r ? r.gid : null;
}
export const setPhone = (env, mobile, gid) => env.DB.prepare(
  'INSERT INTO phones (mobile, gid, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(mobile) DO UPDATE SET gid = ?2, updated_at = ?3'
).bind(mobile, gid, nowMs()).run();

export const addMsg = (env, m) => env.DB.prepare(
  'INSERT INTO msgs (gid, mobile, dir, kind, cost, body, wa_id, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
).bind(m.gid || null, m.mobile || null, m.dir, m.kind || null, m.cost || 0, m.body == null ? null : String(m.body), m.wa_id || null, m.status || null, m.at || nowMs()).run();

// true the first time an id is seen
export async function firstSeen(env, waId) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO seen (wa_id, at) VALUES (?, ?)').bind(waId, nowMs()).run();
  return r.meta.changes === 1;
}

export async function kvGet(env, k) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? r.v : null; }
export const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind(k, String(v)).run();

// IST day key for the paid-message cap
export const istDay = (t = nowMs()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
export async function addCost(env, rs) {
  if (!rs) return;
  const k = 'cost:' + istDay();
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS REAL) + ?2 AS TEXT)").bind(k, String(rs)).run();
}
export async function todayCost(env) { return Number(await kvGet(env, 'cost:' + istDay())) || 0; }
