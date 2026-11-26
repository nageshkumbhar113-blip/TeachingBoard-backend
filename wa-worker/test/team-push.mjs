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
const PORT = 8795, GRAPH = 4731, RENDER = 4732;
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

// ── 🔔 the new-family push to the team's phones (desk.js teamNewPush → Render 'team_push') ──
try {
  const pushes = () => actions.filter(a => a.action === 'team_push');
  const hIST = new Date(Date.now() + 5.5 * 3600e3).getUTCHours(), inHours = hIST >= 6 && hIST < 23;
  await crm('desk/rules', { hours: [6, 23] });
  await ev('E0000000C0', 'form_number', {}, { name: 'जुना', cls: '8th NMMS' }, '9822200001');
  await tick();
  ok(pushes().length === 0, 'first tick: starts from now (no push for families already there)', JSON.stringify(pushes()));
  await sleep(30);
  await ev('E0000000C1', 'form_number', {}, { name: 'सई', cls: '8th NMMS' }, '9822200011');
  await tick();
  if (!inHours) { ok(pushes().length === 0, 'outside the call hours: no push (waits for the morning)'); }
  else {
    const p1 = pushes()[0] || {};
    ok(pushes().length === 1 && p1.one === 'E0000000C1' && p1.gid === 'E0000000C1' && /🆕 नवीन पालक — 15 मिनिटांत call करा/.test(p1.title) && /सई/.test(p1.text) && !/जुना/.test(p1.text), 'one new family → one push naming it, a tap opens its card', JSON.stringify(p1));
    await tick();
    ok(pushes().length === 1, 'the next tick: not told again');
    await ev('E0000000C2', 'form_number', {}, { name: 'ओम', cls: '8th NMMS' }, '9822200012');
    await ev('E0000000C3', 'form_number', {}, { name: 'आर्या', cls: '8th NMMS' }, '9822200013');
    await tick();
    const p2 = pushes()[1] || {};
    ok(pushes().length === 2 && /🆕 2 नवीन पालक/.test(p2.title) && /ओम/.test(p2.text) && /आर्या/.test(p2.text) && p2.one === '', 'two at once → one push "2 नवीन पालक" with both names', JSON.stringify(p2));
    // a family the team already called is not "new"
    await ev('E0000000C4', 'form_number', {}, { name: 'रिया', cls: '8th NMMS' }, '9822200014');
    await crm('desk/attempt/E0000000C4', { how: 'call' });
    await tick();
    ok(pushes().length === 2 || !/रिया/.test((pushes()[2] || {}).text || ''), 'a family already called: no push', JSON.stringify(pushes()[2]));
    // outside the hours: no push; the families wait
    await crm('desk/rules', { hours: [hIST >= 22 ? 6 : hIST + 1, 23] });
    await ev('E0000000C5', 'form_number', {}, { name: 'तनय', cls: '8th NMMS' }, '9822200015');
    const before = pushes().length;
    await tick();
    ok(pushes().length === before, 'outside the call hours: no push');
    await crm('desk/rules', { hours: [6, 23] });
    await tick();
    ok(pushes().length === before + 1 && /तनय/.test(pushes()[before].text), 'when the hours start: the waiting family is told', JSON.stringify(pushes()[before]));
  }
} catch (e) { console.log('CRASH', e && e.stack); fails++;

} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
