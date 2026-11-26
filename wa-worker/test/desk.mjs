// Call desk (src/desk.js) end-to-end on this computer — built from run.mjs's harness.
// End-to-end test of the Worker on this computer: wrangler dev (local D1) + a fake Meta Graph API
// + a fake Render. Run: npm test   (needs nothing from Cloudflare or Meta)
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(DIR, '.wrangler', 'test-state-' + Date.now());
const PORT = 8797, GRAPH = 4711, RENDER = 4712;
const SECRET = 'test-shared-secret', APP_SECRET = 'test-app-secret', VERIFY = 'test-verify';
const W = `http://127.0.0.1:${PORT}`;
const A = 'AAAA111111', B = 'BBBB222222';

let fails = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + extra)); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fake Meta: records every message the bot sends ──
const sent = [];
let waN = 0;
const graph = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  if (req.headers.authorization !== 'Bearer test-wa-token') { res.statusCode = 401; return res.end('{}'); }
  sent.push(body);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ messages: [{ id: 'wamid.' + (++waN) }] }));
}).listen(GRAPH);

// ── fake Render: lead facts + the actions the bot asks for ──
const actions = [];
const render = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-bot-key'] !== SECRET) { res.statusCode = 401; return res.end('{}'); }
  const m = req.url.match(/^\/api\/guest\/bot\/lead\/(\w+)/);
  if (m) return res.end(JSON.stringify({ data: { name: m[1] === A ? 'Rahul' : 'Sai', cls: '8th NMMS', freeTotal: 18, courses: ['4थी–10वी', 'NMMS'], prices: { monthly: 200, yearly: 1500 } } }));
  if (req.url === '/api/guest/bot/action') { actions.push(JSON.parse(raw)); return res.end('{"success":true}'); }
  res.statusCode = 404; res.end('{}');
}).listen(RENDER);

const textOf = b => b.type === 'text' ? b.text.body : b.type === 'interactive' ? b.interactive.body.text : b.type === 'template' ? 'TEMPLATE:' + b.template.name : '';
const ctaUrl = b => b && b.type === 'interactive' && b.interactive.type === 'cta_url' ? b.interactive.action.parameters.url : '';
const signed = async (payload) => {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return fetch(W + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
};
let mid = 0;
const msg = (from, text, kind = 'text', id) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [
  kind === 'text' ? { id: id || 'in.' + (++mid), from, type: 'text', text: { body: text } }
    : { id: id || 'in.' + (++mid), from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: text, title: text } } },
] } }] }] });
// the webhook answers at once and works after; wait until the bot's messages arrive
async function waitSent(n, ms = 8000) { const t = Date.now(); while (sent.length < n && Date.now() - t < ms) await sleep(100); return sent.length; }
const ev = (gid, type, data, sync, mobile) => fetch(W + '/event', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Key': SECRET }, body: JSON.stringify({ gid, type, data, sync, mobile }) }).then(r => r.json());
const tick = () => fetch(W + '/tick', { method: 'POST', headers: { 'X-Bot-Key': SECRET } }).then(r => r.json());
const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const p = b64(JSON.stringify({ role: 'admin', exp: Date.now() + 3600e3 }));
const TOKEN = p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('hex');
const crm = (pth, body) => fetch(W + '/crm/' + pth, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));

// ── start the Worker (first stop any run left over from an earlier test on this port) ──
function killStray() {
  if (process.platform !== 'win32') return;
  try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'wa-worker.node_modules' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' }); } catch {}
}
killStray();
for (const d of fs.existsSync(path.join(DIR, '.wrangler')) ? fs.readdirSync(path.join(DIR, '.wrangler')) : []) if (d.startsWith('test-state')) try { fs.rmSync(path.join(DIR, '.wrangler', d), { recursive: true, force: true }); } catch {}
fs.writeFileSync(path.join(DIR, '.dev.vars'), `WA_TOKEN=test-wa-token\nWA_PHONE_ID=123\nMETA_APP_SECRET=${APP_SECRET}\nVERIFY_TOKEN=${VERIFY}\nSHARED_SECRET=${SECRET}\n`);
execSync(`npx wrangler d1 execute nks-wa --local --persist-to "${STATE}" --file=schema.sql`, { cwd: DIR, stdio: 'ignore' });
const wr = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', '"' + STATE + '"',
  '--var', `GRAPH_URL:http://127.0.0.1:${GRAPH}`, '--var', `RENDER_URL:http://127.0.0.1:${RENDER}`, '--var', 'BOT_NUMBER:919999999999', '--var', 'DAILY_CAP_RS:1'],
  { cwd: DIR, shell: true });
let log = ''; wr.stdout.on('data', d => { log += d; }); wr.stderr.on('data', d => { log += d; });
for (let i = 0; i < 120; i++) { try { if ((await fetch(W + '/health')).ok) break; } catch {} await sleep(500); }


const staff = (id, name) => { const q = b64(JSON.stringify({ role: 'staff', by: id, name, exp: Date.now() + 3600e3 })); return q + '.' + crypto.createHmac('sha256', SECRET).update(q).digest('hex'); };
const T1 = staff('m1', 'प्रिया'), T2 = staff('m2', 'अनिता');
const as = (tok, pth, b) => fetch(W + '/crm/desk/' + pth, { method: b ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));
const G = ['D0000000A1', 'D0000000A2', 'D0000000A3', 'D0000000A4', 'D0000000A5', 'D0000000A6'];
try {
  // six families from the website (number given), one has opened the pay page, one took a test (offer running)
  for (let i = 0; i < G.length; i++) ok((await ev(G[i], 'form_number', {}, { name: 'Kid' + i, cls: '8th NMMS' }, '98111000' + (10 + i))).success, 'family ' + (i + 1) + ' in');
  await ev(G[1], 'pay_seen', { checkout: true });
  await ev(G[2], 'test_done', { n: 1, score: 12, total: 20 }, { testsDone: 1 });
  let h = await as(T1, 'home');
  ok(h.success && h.data.day.items.length >= 5, 'प्रिया: the day list is made (#1…)', JSON.stringify(h).slice(0, 300));
  ok(h.data.day.items[0].gid === G[1] && h.data.day.items[0].cat === 1 && h.data.day.items[0].n === 1, '#1 = the family that pressed Pay (💳 first)', JSON.stringify(h.data.day.items.slice(0, 2)));
  ok(h.data.alert.length >= 5 && h.data.alert.every(a => a.left_min <= 15), 'new families: the red 15-minute alert', JSON.stringify(h.data.alert.slice(0, 2)));
  ok(h.data.totals.all >= 6 && h.data.totals.left >= 6, 'totals: all / left', JSON.stringify(h.data.totals));
  const first = h.data.day.items.map(x => x.gid + x.n).join();
  ok((await as(T1, 'home')).data.day.items.map(x => x.gid + x.n).join() === first, 'reopening keeps the same numbers');
  let h2 = await as(T2, 'home');
  ok(!h2.data.day.items.some(x => h.data.day.items.some(y => y.gid === x.gid)), 'अनिता never gets प्रिया\'s families the same day', JSON.stringify(h2.data.day.items.map(x => x.gid)));
  // 📞 call → lock
  ok((await as(T1, 'attempt/' + G[1], { via: 'call' })).success, 'प्रिया: 📞 Call recorded');
  let r = await as(T2, 'attempt/' + G[1], { via: 'call' });
  ok(r.status === 409 && r.code === 'LOCKED' && /प्रिया/.test(r.message), 'अनिता on the same family: 🔒 "प्रिया बोलत आहेत"', JSON.stringify(r));
  r = await as(T2, 'lead/' + G[1]);
  ok(r.data.lock && r.data.lock.name === 'प्रिया', 'card shows the lock to अनिता');
  // outcomes
  r = await as(T1, 'outcome/' + G[1], { result: 'no' });
  ok(r.status === 400, '❌ नको without a reason is refused');
  r = await as(T1, 'outcome/' + G[1], { result: 'paying', reason: 'उद्या', note: 'वडील तयार' });
  ok(r.success && r.data.next, '💳 Pay करणार: saved, next contact set (tomorrow check)', JSON.stringify(r));
  r = await as(T1, 'lead/' + G[1]);
  ok(r.data.lead.next && r.data.lead.next.timed && /झालं का/.test(r.data.lead.next.why) && r.data.stage === 3, 'card: next = "pay झालं का?" (timed), stage = will pay', JSON.stringify(r.data.lead.next));
  ok(!r.data.lock, 'lock released after the outcome');
  h = await as(T1, 'home');
  const row1 = h.data.day.items.find(x => x.gid === G[1]);
  ok(row1 && row1.status === 'done' && row1.outcome === 'paying' && h.data.day.done === 1, 'the list: #1 ✅ (done), 1 done', JSON.stringify(row1));
  ok(h.data.today.calls === 1 && h.data.today.paying === 1, 'my today: 1 call, 1 will pay', JSON.stringify(h.data.today));
  // talk → +2 days; no answer ×3 → WhatsApp only; later → today's callbacks
  const later = new Date(Date.now() + 40 * 60e3).toISOString();
  ok((await as(T1, 'outcome/' + G[2], { result: 'talk', reason: 'test देणार' })).success, '✅ बोललो');
  r = await as(T1, 'lead/' + G[2]);
  ok(r.data.lead.next && r.data.lead.next.at > Date.now() + 36 * 3600e3, 'बोललो → next contact in 2 days', r.data.lead.next && new Date(r.data.lead.next.at).toISOString());
  for (let i = 0; i < 3; i++) await as(T1, 'outcome/' + G[3], { result: 'noanswer' });
  r = await as(T1, 'lead/' + G[3]);
  ok(r.data.lead.noCall === true && r.data.lead.noAnswer === 3, '📵 3 times → WhatsApp only (no more calls)', JSON.stringify({ n: r.data.lead.noAnswer, nc: r.data.lead.noCall }));
  ok((await as(T1, 'outcome/' + G[4], { result: 'later', reason: 'आज रात्री', at: later })).success, '⏰ नंतर with a time');
  h = await as(T1, 'home');
  ok(h.data.callbacks.some(c => c.gid === G[4] && Math.abs(c.at - Date.parse(later)) < 1000), "⏰ today's callbacks show it with its time", JSON.stringify(h.data.callbacks));
  // skip → to the end; teacher → Admin; wrong number
  const before = h.data.day.items.find(x => x.gid === G[5]);
  if (before) {
    await as(T1, 'skip/' + G[5], { why: 'busy' });
    h = await as(T1, 'home');
    const after = h.data.day.items.find(x => x.gid === G[5]);
    ok(after && after.n > Math.max(...h.data.day.items.filter(x => x.gid !== G[5]).map(x => x.n)), '⏭ skip: to the end of the list with a new number', JSON.stringify([before.n, after && after.n]));
  }
  ok((await as(T2, 'teacher/' + G[0], { note: '8वी, 40 विद्यार्थी' })).success, '👩‍🏫 teacher → Admin');
  ok((await as(T2, 'outcome/' + G[5], { result: 'wrong' })).success, '☎️ नंबर चुकीचा');
  // discount above the member's limit → the Admin
  ok((await as(T1, 'disc/' + G[2], { pct: 50, why: 'बजेट' })).success, '🎁 50% asked of the Admin');
  r = await as(T1, 'rules', { daySize: 10 });
  ok(r.status === 403, 'a member cannot change the rules');
  // the payment → credited to the member who handled the family
  await ev(G[1], 'paid', { code: 'KID111', amount: 349, period: 'yearly', pay_id: 'pay_desk_1' });
  const a = await crm('desk/admin');
  ok(a.success, 'Admin view opens', JSON.stringify(a).slice(0, 200));
  const p1 = a.data.team.find(x => x.id === 'm1'), p2 = a.data.team.find(x => x.id === 'm2');
  ok(p1 && p1.calls === 1 && p1.paying === 1 && p1.talk === 1 && p1.noanswer === 3 && p1.paid === 1, 'Admin team table: प्रिया — 1 call, 1 talk, 1 will pay, 3 no answer, 1 paid', JSON.stringify(p1));
  ok(p2 && p2.closed >= 1, 'Admin team table: अनिता — 1 closed (wrong number)', JSON.stringify(p2));
  ok(a.data.lost.some(x => /नंबर चुकीचा|wrong/.test(x.reason) || x.reason === '') || a.data.sources.some(s => s.wrong >= 1), 'wrong number shows in the Admin report', JSON.stringify({ lost: a.data.lost, src: a.data.sources }));
  ok(a.data.sources.some(s => s.source === 'Website नंबर' && s.leads >= 6), 'sources: "Website नंबर" with its families', JSON.stringify(a.data.sources));
  ok(a.data.speed.n >= 1 && a.data.speed.median_min !== null, 'speed to the first call measured', JSON.stringify(a.data.speed));
  ok(a.data.approvals.some(x => x.gid === G[2] && x.pct === 50 && x.by === 'प्रिया'), 'discount request waits for the Admin', JSON.stringify(a.data.approvals));
  ok(a.data.teachers.some(x => x.gid === G[0] && x.fwd && x.fwd.by === 'अनिता'), 'Teacher Demo list: the teacher sent by अनिता', JSON.stringify(a.data.teachers));
  r = await crm('desk/approve', { gid: G[2], ok: true });
  ok(r.success && r.data.ok === true, 'Admin approves the 50%');
  r = await crm('desk/rules', { daySize: 30, newMin: 10, staffDisc: [20, 30] });
  ok(r.success && r.data.daySize === 30 && r.data.newMin === 10, 'Admin changes the rules', JSON.stringify(r.data));
  h2 = await as(T2, 'home');
  ok(!h2.data.day.items.some(x => x.gid === G[0] && x.status !== 'done'), 'the teacher is out of the team list', JSON.stringify(h2.data.day.items));

} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
