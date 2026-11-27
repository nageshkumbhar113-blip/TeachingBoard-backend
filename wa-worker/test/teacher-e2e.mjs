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
const PORT = 8794, GRAPH = 4741, RENDER = 4742;
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
  '--var', `GRAPH_URL:http://127.0.0.1:${GRAPH}`, '--var', `RENDER_URL:http://127.0.0.1:${RENDER}`, '--var', 'BOT_NUMBER:919999999999', '--var', 'DAILY_CAP_RS:1', '--var', 'MEET_PAGE:'],
  { cwd: DIR, shell: true });
let log = ''; wr.stdout.on('data', d => { log += d; }); wr.stderr.on('data', d => { log += d; });
for (let i = 0; i < 120; i++) { try { if ((await fetch(W + '/health')).ok) break; } catch {} await sleep(500); }

// ── 👩‍🏫 Teacher Guide through the real Worker (wrangler dev): WhatsApp in → Render job → codes → steps → the team ──
try {
  const T = '919822555001', last = () => textOf(sent[sent.length - 1] || {});
  const allSince = n => sent.slice(n).map(textOf).join('\n---\n');
  const btnIds = b => b && b.type === 'interactive' ? (b.interactive.action.buttons || []).map(x => x.reply.id).concat(((b.interactive.action.sections || [])[0] || { rows: [] }).rows.map(r => r.id)) : [];
  await signed(msg(T, 'नमस्कार'));
  await waitSent(1);
  let n = sent.length;
  await signed(msg(T, 'मी शिक्षक आहे'));
  await waitSent(n + 1);
  ok(/शिक्षकांचं स्वागत/.test(last()) && /कोणत्या वर्गाला/.test(last()), '"मी शिक्षक आहे" → the teacher flow (the class asked)', last());
  n = sent.length;
  await signed(msg(T, '8वी NMMS'));
  await waitSent(n + 1);
  ok(/नाव आणि शाळा/.test(last()), 'class → name + school asked', last());
  n = sent.length;
  await signed(msg(T, 'संजय पाटील, जि. प. शाळा कागल'));
  await waitSent(n + 1);
  await sleep(800);
  const job = actions.find(a => a.action === 'teacher_account');
  ok(job && job.name === 'संजय पाटील' && job.school === 'जि. प. शाळा कागल' && job.course === '8वी NMMS' && job.mobile === '9822555001', 'Render asked: teacher_account (name, school, class, mobile)', JSON.stringify(job));
  const gid = job && job.gid;
  // Render's answer (what botController sends back with BOT.notify)
  n = sent.length;
  await ev(gid, 'tdemo', { account: { tCode: 'SAN321', tPin: '7284', sCode: 'JIP5001', sPin: '3916', course: '8th NMMS EXAM 26-27 BATCH', until: new Date(Date.now() + 72 * 3600e3).toISOString() } });
  await waitSent(n + 2);
  const got = allSince(n);
  ok(/SAN321/.test(got) && /JIP5001/.test(got) && /Step 1\/7/.test(got) && /teacher-guide#login/.test(got), 'codes + Step 1 on WhatsApp', got);
  ok(btnIds(sent[sent.length - 1]).includes('ts:done'), 'Step 1 has ✅ / ❓ buttons');
  await sleep(500);
  ok(actions.some(a => a.action === 'team_push' && /नवीन शिक्षक/.test(a.title)), 'team push: 🆕 नवीन शिक्षक (to Render)');
  // the app: login → step 2
  n = sent.length;
  await ev(gid, 'tdemo', { tLogin: true });
  await waitSent(n + 2);
  ok(/Step 2\/7/.test(allSince(n)), 'app login → Step 2 by itself', allSince(n));
  // the team: "step done" → step 3
  n = sent.length;
  const r = await crm('desk/tstep/' + gid, {});
  await waitSent(n + 2);
  ok(r.success && /Step 3\/7/.test(allSince(n)), 'Team app "✅ Step पूर्ण करून दिली" → Step 3', JSON.stringify(r) + ' ' + allSince(n));
  // a question with the AI off → the team + push
  n = sent.length;
  await signed(msg(T, 'Share link कुठे मिळेल?'));
  await waitSent(n + 1);
  await sleep(500);
  ok(/team कडे दिला/.test(last()) && actions.some(a => a.action === 'team_push' && /प्रश्न/.test(a.title)), 'a question (AI off) → team + push', last());
  const list = await crm('list?list=teacher');
  const me = (list.data || []).find(x => x.gid === gid);
  ok(me && /Step 3\/7/.test(me.stage) && me.call_now, 'teacher list: "Step 3/7 · विद्यार्थी", call now', JSON.stringify(me));
  const home = await crm('desk/home');
  ok(home.data.teachers >= 1 && (home.data.tStuck || []).some(x => x.gid === gid), 'desk home: teachers + tStuck', JSON.stringify(home.data.tStuck));
} catch (e) { console.log('CRASH', e && e.stack); fails++;

} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
