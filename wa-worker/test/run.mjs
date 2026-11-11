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
const PORT = 8799, GRAPH = 4701, RENDER = 4702;
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

try {
  // 1) Meta's webhook check, and a forged webhook
  let r = await fetch(`${W}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`);
  ok(r.status === 200 && (await r.text()) === '42', 'webhook verify answers the challenge');
  r = await fetch(`${W}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  ok(r.status === 403, 'wrong verify token refused');
  r = await fetch(W + '/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=00' }, body: JSON.stringify(msg('919811100001', 'hi')) });
  ok(r.status === 401, 'unsigned webhook refused');
  r = await fetch(W + '/event', { method: 'POST', headers: { 'X-Bot-Key': 'nope' }, body: '{}' });
  ok(r.status === 401, 'event without the shared key refused');
  ok((await crm('summary')).status === 200 && (await fetch(W + '/crm/summary')).status === 401, 'CRM needs the Admin token');

  // 2) the child's first test on the website (Render tells the bot), then the parent taps "WhatsApp वर result"
  r = await ev(A, 'test_done', { score: 16, total: 20, rank: 42, of: 340, weak: 'आकृती' });
  ok(r.success, 'first test event creates the lead', JSON.stringify(r));
  const first = msg('919811100001', `RESULT ${A}`); r = await signed(first);
  ok(r.status === 200, 'signed webhook accepted');
  await waitSent(2);
  ok(sent.length === 2, 'two answers: result + daily question', sent.length);
  ok(/Rahul चा पूर्ण result/.test(textOf(sent[0])) && /16\/20/.test(textOf(sent[0])), 'result names the child (from Render) with the score', textOf(sent[0]));
  ok(sent[0].to === '919811100001', 'sent to the parent\'s number');
  ok(sent[0].interactive?.type === 'button' && sent[0].interactive.action.buttons.length === 3, 'result: 3 reply buttons (Unlock / प्रश्न / Call)', JSON.stringify(sent[0].interactive?.type));
  ok(JSON.stringify(sent).includes('Monthly ₹200 → ₹100') && JSON.stringify(sent).includes('parent-pay.html?g=AAAA111111'), 'first answer: the unlock line with the offer price and the pay link (prices from Render)');
  ok(sent[1].interactive?.type === 'list' && sent[1].interactive.action.sections[0].rows.length === 4, 'daily-time question as a list of 4');

  // 3) the same message again (Meta retry) → nothing new
  await signed(first);
  await sleep(1500);
  ok(sent.length === 2, 'a repeated webhook is ignored', sent.length);

  // 4) the parent picks 7 pm (a list reply), then asks for a test twice
  await signed(msg('919811100001', 'daily:19', 'button')); await waitSent(3);
  ok(/रोज 7 वाजता Rahul/.test(textOf(sent[2])), 'daily time saved', textOf(sent[2]));
  // the Worker runs on the real clock: on a Sunday (IST) TEST answers with the महा-Test instead of a daily test
  const sunday = new Date(Date.now() + 5.5 * 3600e3).getUTCDay() === 0;
  await signed(msg('919811100001', 'TEST')); await waitSent(4);
  if (sunday) ok(/आज महा-Test चा दिवस/.test(textOf(sent[3])), 'TEST on Sunday → the महा-Test', textOf(sent[3]));
  // one free test a day wherever it was taken: the child's first test was today → "today's is done" (+ the app)
  else ok(/आजची free test झाली आहे/.test(textOf(sent[3])) && /play\.google\.com/.test(textOf(sent[3])), 'TEST after today\'s test → "today\'s is done" + the app', textOf(sent[3]));
  ok(sent[3].interactive?.type === 'button', '≤3 short buttons → reply buttons');
  await signed(msg('919811100001', 'TEST')); await waitSent(5);
  if (sunday) ok(/आज महा-Test चा दिवस/.test(textOf(sent[4])), 'second TEST on Sunday → the महा-Test again', textOf(sent[4]));
  else ok(/आजची free test झाली आहे/.test(textOf(sent[4])), 'second TEST the same day → "today\'s is done"', textOf(sent[4]));

  // 5) the price question uses Render's real prices
  await signed(msg('919811100001', 'ask:fee', 'button')); await waitSent(6);
  ok(/Monthly ₹200 · Yearly ₹1,500/.test(textOf(sent[5])), 'fee answer from the class prices', textOf(sent[5]));

  // 6) jobs to Render: save the number (+ Meta Lead) — run by the tick
  r = await tick();
  ok(r.success && actions.some(a => a.action === 'lead' && a.gid === A && a.mobile === '9811100001'), 'tick sends "lead" (number) to Render', JSON.stringify(actions));

  // 7) the child's next test → the result comes by itself; then "उद्याची पाठवा" → the share message after the 2nd test
  r = await ev(A, 'test_done', { score: 7, total: 10, weak: 'वेन आकृती' });
  await waitSent(7);
  ok(/Rahul ने आजची test दिली: 7\/10/.test(textOf(sent[6])), 'test result sent to the parent', textOf(sent[6]));
  await signed(msg('919811100001', 'next', 'button')); await waitSent(9);
  ok(/उद्या पुढची पाठवतो/.test(textOf(sent[7])) && /ओळखीच्या विद्यार्थ्यांना/.test(textOf(sent[8])), 'tomorrow + the courses/share message', textOf(sent[8]));

  // 8) an unknown number without a code → a free welcome
  const before = sent.length;
  await signed(msg('919822200002', 'hi')); await waitSent(before + 1); await sleep(1500);
  const welcomeMsgs = sent.slice(before).filter(m => m.to === '919822200002').map(textOf);
  ok(welcomeMsgs.some(x => /स्वागत/.test(x)) && welcomeMsgs.some(x => /free test/.test(x)), 'unknown number → welcome + the free test (or the class / name asked)', welcomeMsgs.join(' | '));

  // 9) a form-number lead (no WhatsApp): nothing is sent, it waits in the call list
  const n9 = sent.length;
  await ev(B, 'test_done', { score: 9, total: 20 }, { name: 'Sai' });
  r = await ev(B, 'form_number', {}, null, '9833300003');
  await sleep(800);
  ok(sent.length === n9, 'form lead: the bot sends nothing (would cost)');
  let s = await crm('list?list=form');
  ok(s.data?.some(x => x.gid === B), 'form lead in the CRM "form" list', JSON.stringify(s));

  // 10) CRM: team message (free, wa.me with the bot link), call → close with next-year date, template refused
  r = await crm(`lead/${B}/team`, {});
  ok(r.success && /wa\.me\/919999999999\?text=TEST/.test(r.data.team[0].text), 'team message carries the bot chat link', JSON.stringify(r));
  r = await crm(`lead/${B}/bot-template`, {});
  const lb = await crm(`lead/${B}`);
  ok(lb.data.msgs.some(m => m.kind === 'CAP' || m.kind === 'NO_TEMPLATE'), 'bot template refused (cap / no approved template)', JSON.stringify(lb.data.msgs.slice(-3)));
  r = await crm(`lead/${B}/call`, { result: 'not_interested', reason: 'फी जास्त' });
  s = await crm('list?list=closed');
  const closed = s.data?.find(x => x.gid === B);
  ok(closed && closed.closed === 'फी जास्त' && /^2027-06-01/.test(closed.revisit_at), 'call → closed, reason kept, back on 1 June 2027', JSON.stringify(closed));

  // 11) the inbox reply works only in the open window
  r = await crm(`lead/${A}/reply`, { text: 'नमस्कार, मी टीममधून 🙏' });
  ok(r.success, 'reply inside the open window');
  r = await crm(`lead/${B}/reply`, { text: 'x' });
  ok(r.status === 409, 'reply refused when the window is closed (form lead never wrote)');

  // 12) summary + the lead's chat
  s = await crm('summary');
  ok(s.data.counts.closed === 1 && s.data.last_webhook && s.data.last_tick, 'summary: counts and bot status', JSON.stringify(s.data));
  // ☀️ "call first": unpaid families with the offer still running (soonest end on top), with the time left
  const callFirst = await crm('list?list=first');
  ok(Array.isArray(callFirst.data) && typeof s.data.counts.first === 'number' && callFirst.data.length === s.data.counts.first
    && callFirst.data.every(x => !x.paid && !x.closed && (x.offer_end || x.mt || x.no_test)), '"call first" list: unpaid, open offer, a महा-Test or a number without a test', JSON.stringify(callFirst.data?.map(x => [x.gid, x.offer_end])));
  const la = await crm(`lead/${A}`);
  ok(la.data.msgs.filter(m => m.dir === 'in').length >= 5 && la.data.msgs.some(m => m.dir === 'out'), 'the chat log has both sides');

  // 13) STOP → nothing more, even on TEST… until START
  await signed(msg('919811100001', 'STOP')); await sleep(1500);
  const n13 = sent.length;
  await ev(A, 'test_done', { score: 8, total: 10 }); await sleep(1500);
  ok(sent.length === n13 && /मेसेज बंद/.test(textOf(sent[n13 - 1])), 'after STOP: one goodbye, then nothing (not even a test result)', textOf(sent[sent.length - 1]));
} catch (e) {
  ok(false, 'crashed: ' + e.stack);
} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
