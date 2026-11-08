// Tells the WhatsApp bot (Cloudflare Worker, wa-worker/) what happened here: a free test, a payment,
// the app, a महा-Test result… Fire-and-forget: never slows a request and never throws. Off unless both
// WA_WORKER_URL and BOT_SHARED_SECRET are set in the environment.
const crypto = require('crypto');

const on = () => !!(process.env.WA_WORKER_URL && process.env.BOT_SHARED_SECRET);

// Two events for one child at once (a test result and the number): the Worker works on one at a time and
// refuses the other ("lead busy") — so a refused or failed event is tried again (twice, a few seconds apart).
function notify(gid, type, data = {}, extra = {}, attempt = 1) {
  if (!on() || !gid) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  const again = why => {
    if (attempt < 3) setTimeout(() => notify(gid, type, data, extra, attempt + 1), 2500 * attempt);
    else console.warn('[wa bot] event', type, why);
  };
  fetch(process.env.WA_WORKER_URL.replace(/\/$/, '') + '/event', {
    method: 'POST', signal: ctl.signal,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Key': process.env.BOT_SHARED_SECRET },
    body: JSON.stringify({ gid, type, data, ...extra }),
  }).then(r => { if (r.status >= 500) again(r.status); else if (!r.ok) console.warn('[wa bot] event', type, r.status); })
    .catch(err => again(err.message))
    .finally(() => clearTimeout(timer));
}

// the Worker's own calls (X-Bot-Key); constant-time compare
function keyOk(req) {
  const want = process.env.BOT_SHARED_SECRET || '';
  const got = String(req.get('X-Bot-Key') || '');
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// a short-lived token for Admin › CRM to call the Worker: "<base64url {role, exp}>.<hex HMAC>"
function adminToken(hours = 12) {
  const p = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + hours * 3600e3 })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return p + '.' + crypto.createHmac('sha256', process.env.BOT_SHARED_SECRET).update(p).digest('hex');
}

// a student logged in to the app / turned notifications on with an account made from a free visitor:
// the bot's CRM shows "📲 App ✓ · 🔔 Push ✓" (fire-and-forget)
function appUsed(studentCode, { push = false } = {}) {
  if (!on() || !studentCode) return;
  require('../models/GuestLead').findOne({ converted_code: studentCode }, 'gid').lean()
    .then(l => { if (l) notify(l.gid, 'sync', {}, { sync: push ? { app: true, pushOn: true } : { app: true } }); })
    .catch(() => {});
}

module.exports = { on, notify, keyOk, adminToken, appUsed };
