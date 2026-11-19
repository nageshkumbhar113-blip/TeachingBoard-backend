// ⏰ Keep Render awake only while ads run (owner 2026-11-19: "ping ads chalu asatil tarch").
// The WhatsApp bot (Cloudflare worker) pings this server every 10 min, 6 am – 11 pm IST, so a parent who
// comes from an ad never waits a minute for the free server to wake. That costs ~17 Render hours a day,
// so the bot now pings only while an ad is really running on Meta. This server tells the bot (it cannot ask:
// asking would wake the server): at start-up, every 30 minutes while awake, and soon after the admin
// pauses / resumes / makes an ad. When the ads stop, the bot stops pinging and the server can sleep; an ad
// started straight in Meta Ads Manager is noticed the next time anyone wakes the server (for example the
// first parent who clicks it). If Meta cannot be asked, nothing is sent (the bot keeps the last answer).
const META = require('./meta');

const EVERY_MS = 30 * 60 * 1000;
let _timer = null, _soon = null, _last = null;

// is any ad delivering on Meta right now? (null = could not tell)
async function adsRunning() {
  if (!META.configured().ok) return false;
  try {
    const ads = await META.adsState();
    // running, or about to run (a new ad in review)
    return Object.values(ads).some(a => ['ACTIVE', 'PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED'].includes(a.effective));
  } catch (err) { console.warn('[ads-awake] Meta:', err.message); return null; }
}

async function report() {
  const url = process.env.WA_WORKER_URL, key = process.env.BOT_SHARED_SECRET;
  if (!url || !key) return null;
  const on = await adsRunning();
  if (on === null) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/ads-state', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': key },
      body: JSON.stringify({ on }),
    });
    if (r.ok && _last !== on) console.log(`[ads-awake] ads ${on ? 'running → bot keeps the server awake' : 'stopped → the server may sleep'}`);
    if (r.ok) _last = on;
  } catch (err) { console.warn('[ads-awake] bot:', err.message); }
  return on;
}

// after the admin changed an ad: tell the bot in a minute (Meta needs a moment to show the new state)
function soon(ms = 60 * 1000) {
  clearTimeout(_soon);
  _soon = setTimeout(() => report().catch(() => {}), ms);
}

function start() {
  if (_timer) return;
  setTimeout(() => report().catch(() => {}), 20 * 1000);
  _timer = setInterval(() => report().catch(() => {}), EVERY_MS);
}

module.exports = { start, soon, report, adsRunning };
