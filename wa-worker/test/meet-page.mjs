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
const PORT = 8793, GRAPH = 4751, RENDER = 4752;
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

// ── 📅 Live Demo booking page through the real Worker: WhatsApp → 📅 बुक करा link → /meet/info → /meet/book →
//    Sunday booked + Join button + Render asked for the accounts → codes, no second invite
try {
  const T = '919822666001', allSince = n => sent.slice(n).map(textOf).join(' || ');
  await signed(msg(T, 'नमस्कार'));
  await waitSent(1); await sleep(2500);
  let n = sent.length;
  await signed(msg(T, 'मी शिक्षक आहे'));
  await waitSent(n + 1);
  const inv = sent[sent.length - 1];
  const link = ctaUrl(inv);
  ok(/जागा बुक करा/.test(textOf(inv)) && /शिक्षक account/.test(textOf(inv)) && /^https:\/\/nkseduorbit\.in\/live-demo\?g=[0-9A-F]{10}&t=[a-z0-9]{8,24}$/.test(link), 'a new teacher: the invite with the 📅 बुक करा page link', textOf(inv) + ' | ' + link);
  const u = new URL(link), g = u.searchParams.get('g'), t = u.searchParams.get('t');
  const info = await (await fetch(W + '/meet/info?g=' + g + '&t=' + t)).json();
  ok(info.success && /रविवार/.test(info.data.when) && info.data.booked === false, '/meet/info: the coming Sunday, not booked yet', JSON.stringify(info));
  const wrong = await (await fetch(W + '/meet/info?g=' + g + '&t=wrongtoken1')).json();
  ok(!wrong.success, 'a wrong token is refused', JSON.stringify(wrong));
  const half = await (await fetch(W + '/meet/book', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ g, t, form: { name: 'सुनीता' } }) })).json();
  ok(!half.success && /सगळ्या जागा/.test(half.message), 'empty fields refused');
  n = sent.length;
  const form = { name: 'सुनीता जाधव', school: 'जि. प. शाळा', village: 'कागल', district: 'कोल्हापूर', cls: 'nmms8', students: '21-50' };
  const bk = await (await fetch(W + '/meet/book', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ g, t, form }) })).json();
  ok(bk.success && bk.data.booked && /hsz-addq-znj/.test(bk.data.link) && bk.data.name === 'सुनीता जाधव', '/meet/book: booked, the Meet link for the page', JSON.stringify(bk));
  await waitSent(n + 2);
  const join = sent.slice(n).find(b => /hsz-addq-znj/.test(ctaUrl(b)));
  ok(join && /बुक झालं, \*सुनीता जाधव\*/.test(textOf(join)) && /9:55/.test(textOf(join)), 'WhatsApp: "बुक झालं" + 🎥 Join button ("press at 9:55")', allSince(n));
  await sleep(800);
  const job = actions.find(a => a.action === 'teacher_account' && a.gid === g);
  ok(job && job.name === 'सुनीता जाधव' && /कागल/.test(job.school) && /कोल्हापूर/.test(job.school) && job.course === 'NMMS', 'Render asked for the accounts (name, school + village + district, class)', JSON.stringify(job));
  n = sent.length;
  await ev(g, 'tdemo', { account: { tCode: 'SUN321', tPin: '7284', sCode: 'JIL5001', sPin: '3916', course: 'NMMS', until: new Date(Date.now() + 72 * 3600e3).toISOString() } });
  await waitSent(n + 2);
  ok(/SUN321/.test(allSince(n)) && /Step 1\/7/.test(allSince(n)) && !/जागा बुक करा/.test(allSince(n)), 'codes + Step 1; no second invite (booked)', allSince(n));
  const again = await (await fetch(W + '/meet/info?g=' + g + '&t=' + t)).json();
  const home = await crm('desk/home');
  ok(home.data.meet && home.data.meet.booked === 1 && /रविवार/.test(home.data.meet.when), 'Team home: 📅 1 teacher booked', JSON.stringify(home.data.meet));
  const tl = await crm('list?list=teacher');
  ok((tl.data || []).some(x => x.gid === g && /📅 Demo बुक/.test(x.stage) && x.district === 'कोल्हापूर'), 'teacher list: 📅 Demo बुक + district', JSON.stringify((tl.data || []).find(x => x.gid === g)));
  n = sent.length;
  const oc = await crm('lead/' + g + '/outcome', { result: 'noanswer' });
  await waitSent(n + 1);
  ok(oc.success && sent.slice(n).some(b => /संपर्क झाला नाही/.test(textOf(b)) && /hsz-addq-znj/.test(ctaUrl(b))), 'team: 📵 उचलला नाही → the teacher gets "booked" + Join (bot, at once)', allSince(n));
  const adm = await crm('desk/admin');
  ok(adm.data.meet && adm.data.meet.list.some(x => x.name === 'सुनीता जाधव' && x.students === '21-50'), 'Admin desk: the booked list', JSON.stringify(adm.data.meet));
  ok(again.success && again.data.booked && again.data.hasAccount, 'the page opened again: "booked" view', JSON.stringify(again));
} catch (e) { console.log('CRASH', e && e.stack); fails++;

} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
