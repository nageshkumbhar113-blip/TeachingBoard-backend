// Tells the WhatsApp bot (Cloudflare Worker, wa-worker/) what happened here: a free test, a payment,
// the app, a महा-Test result… Fire-and-forget: never slows a request and never throws. Off unless both
// WA_WORKER_URL and BOT_SHARED_SECRET are set in the environment.
const crypto = require('crypto');

const on = () => !!(process.env.WA_WORKER_URL && process.env.BOT_SHARED_SECRET);

function notify(gid, type, data = {}, extra = {}) {
  if (!on() || !gid) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  fetch(process.env.WA_WORKER_URL.replace(/\/$/, '') + '/event', {
    method: 'POST', signal: ctl.signal,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Key': process.env.BOT_SHARED_SECRET },
    body: JSON.stringify({ gid, type, data, ...extra }),
  }).then(r => { if (!r.ok) console.warn('[wa bot] event', type, r.status); })
    .catch(err => console.warn('[wa bot] event', type, err.message))
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

module.exports = { on, notify, keyOk, adminToken };
