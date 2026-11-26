// End-to-end test of the Worker on this computer: wrangler dev (local D1) + a fake Meta Graph API
// + a fake Render. Run: npm test   (needs nothing from Cloudflare or Meta)
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'file:///E:/Teaching%20Board/node_modules/playwright/index.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(DIR, '.wrangler', 'test-state-' + Date.now());
const PORT = 8796, GRAPH = 4721, RENDER = 4722;
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

// ── the team app's files, served from this computer ──
const ROOT = path.resolve('E:/Teaching Board');
const statics = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(f));
}).listen(4729);
const staffTok = (id, name) => { const q = b64(JSON.stringify({ role: 'staff', by: id, name, exp: Date.now() + 3600e3 })); return q + '.' + crypto.createHmac('sha256', SECRET).update(q).digest('hex'); };
const G = ['E0000000B1', 'E0000000B2', 'E0000000B3'];
let browser;
try {
  for (let i = 0; i < G.length; i++) await ev(G[i], 'form_number', {}, { name: ['सई', 'ओम', 'आर्या'][i], cls: '8th NMMS', prices: { monthly: 149, yearly: 499 }, acct: { code: 'KID10' + i, pin: '48' + i + '1' } }, '98222000' + (10 + i));
  await ev(G[0], 'pay_seen', { checkout: true });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const offers = [], pushTokens = [];
  // the team app's Render calls (login, bot token, offers) — answered here; nothing reaches the real server
  await ctx.route('http://fake-render/**', async route => {
    const u = new URL(route.request().url()), j = o => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (u.pathname === '/api/guest/admin/bot-token') return j({ success: true, data: { ready: true, url: W, token: staffTok('m1', 'प्रिया') } });
    if (u.pathname === '/api/team/device-token') { pushTokens.push(JSON.parse(route.request().postData() || '{}')); return j({ success: true }); }
    if (u.pathname === '/api/guest/offer-config') return j({ success: true, data: { team_on: true, team_percents: [20, 30, 50], team_hours: 3 } });
    if (u.pathname === '/api/guest/admin/team-offer') { const b = JSON.parse(route.request().postData() || '{}'); offers.push(b); return j({ success: true, data: { expires_at: new Date(Date.now() + 3 * 3600e3).toISOString(), hours: 3, pay_url: 'https://nkseduorbit.in/p/' + b.gid } }); }
    return j({ success: true, data: [] });
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('teachingboard_api_url', 'http://fake-render/api');
    // the app's push plugin (Capacitor), faked: the listeners are kept so the test can fire them
    const L = {}; window.__push = L;
    window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications: { addListener: (n, f) => { L[n] = f; }, requestPermissions: async () => ({ receive: 'granted' }), register: async () => { setTimeout(() => L.registration && L.registration({ value: 'fcm-tok-1' }), 50); } } } };
    localStorage.setItem('nks_team_token', 'team-test');
    localStorage.setItem('nks_team_me', JSON.stringify({ id: 'm1', name: 'प्रिया' }));
    // a tel: / wa.me link must not leave the page in the test
    document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="https://wa.me"]'); if (a) { window.__lastHref = a.href; e.preventDefault(); } }, true);
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.text()); }); page.on('requestfailed', r => console.log('REQFAIL', r.url(), r.failure() && r.failure().errorText));
  await page.goto('http://127.0.0.1:4729/team-app/index.html');
  await page.waitForSelector('.dk-home', { timeout: 30000 }).catch(async e => { await page.screenshot({ path: process.env.SHOTS + '/ui-fail.png' }); console.log('BODY', (await page.locator('body').innerText()).slice(0, 300), 'ERRS', errs.join(' | '), 'HTML', (await page.content()).slice(0, 400)); throw e; });
  ok(await page.locator('.dk-alert').count() >= 1, 'home: 🆕 new-family alert (15 minutes)', await page.locator('.dk-home').innerText());
  const todayTxt = await page.locator('.dk-today').innerText();
  ok(/0\/3/.test(todayTxt) && /पुढचा: #1 सई/.test(todayTxt), 'home: 🎯 आजचं काम 0/3 · पुढचा #1 सई (💳 first)', todayTxt);
  await page.screenshot({ path: process.env.SHOTS + '/ui-home.png', fullPage: true });
  await page.click('.dk-today');
  await page.waitForSelector('.dk-row');
  ok((await page.locator('.dk-row').count()) === 3 && /#1/.test(await page.locator('.dk-row').first().innerText()), 'day list: 3 numbered families');
  await page.click('.btn.pri');   // ▶ पुढचा
  await page.waitForSelector('.dk-facts');
  const card = await page.locator('#main').innerText();
  ok(/सई/.test(card) && /Free \(demo\)/.test(card) && /KID100 · 4801/.test(card) && /बोलताना सांगा/.test(card) && /8वी NMMS Test Series/.test(card), 'card: plan, Code · PIN, "बोलताना सांगा", Test Series name', card.slice(0, 400));
  await page.screenshot({ path: process.env.SHOTS + '/ui-card.png', fullPage: true });
  // 📞 Call → attempt recorded; back in the app → "काय झालं?"
  await page.click('#c-call');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.sheet .dk-out', { timeout: 5000 });
  ok(true, 'after 📞 Call: "काय झालं?" opens by itself');
  await page.click('[data-o="no"]');
  ok(await page.locator('#o-save').isDisabled(), '❌ नको: Save stays off until a reason is chosen');
  await page.click('[data-o="paying"]');
  await page.click('.dk-reasons button >> nth=1');
  await page.screenshot({ path: process.env.SHOTS + '/ui-outcome.png' });
  await page.click('#o-save');
  await page.waitForFunction(() => { const h = document.querySelector('header'); return h && /#[2-9] \/ 3/.test(h.innerText) && document.querySelector('.dk-facts'); }, null, { timeout: 15000 });
  const card2 = await page.locator('#main').innerText();
  ok(!/सई/.test(card2.split('\n')[0]) && /#\d+ \/ 3/.test(await page.locator('header').innerText()), 'saved → the next family opens (#2 / 3)', (await page.locator('header').innerText()));
  // 💬 Chat: ✍️ own text (empty, focused), 💳 pay text, 🎁 30% → price changes; 50% → asks the Admin
  await page.click('#c-chat');
  await page.waitForSelector('.dk-quick');
  await page.click('[data-k="own"]');
  await page.waitForTimeout(150);
  ok((await page.locator('#dk-text').inputValue()) === '' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'dk-text'), '✍️ स्वतः लिहा: an empty box with the cursor in it');
  await page.click('[data-k="pay"]');
  let txt = await page.locator('#dk-text').inputValue();
  ok(/Test Series/.test(txt) && /nkseduorbit\.in\/p\/E0000000B/.test(txt) && /₹149/.test(txt), '💳 Pay link message: Test Series, price, short /p/ link (bot window closed)', txt);
  await page.click('[data-p="30"]');
  await page.waitForTimeout(600);
  txt = await page.locator('#dk-text').inputValue();
  ok(offers.length === 1 && offers[0].percent === 30 && /₹149 → ₹104/.test(txt), '🎁 30%: given at once, the price in the message changes', txt);
  await page.click('[data-p="50"]');
  await page.waitForTimeout(600);
  ok(offers.length === 1, '🎁 50%: not given by the member (asked of the Admin)');
  await page.screenshot({ path: process.env.SHOTS + '/ui-chat.png', fullPage: true });
  const a = await crm('desk/admin');
  ok(a.data.approvals.some(x => x.pct === 50 && x.by === 'प्रिया'), 'the Admin sees the 50% request', JSON.stringify(a.data.approvals));
  ok(a.data.team.some(p => p.name === 'प्रिया' && p.calls === 1 && p.paying === 1), 'the Admin table: प्रिया — 1 call, 1 will pay', JSON.stringify(a.data.team));
  // 🔔 the new-family push
  ok(pushTokens.length === 1 && pushTokens[0].token === 'fcm-tok-1', '🔔 the phone token is sent once (the home screen opened twice)', JSON.stringify(pushTokens));
  await page.evaluate(() => window.__push.pushNotificationReceived({ title: '🆕 नवीन पालक — 15 मिनिटांत call करा', data: { kind: 'team_new' } }));
  ok(/नवीन पालक/.test(await page.locator('.toast').last().innerText()), '🔔 a push while the app is open: a toast');
  await page.evaluate(g => window.__push.notificationActionPerformed({ notification: { data: { kind: 'team_new', gid: g } } }), G[2]);
  await page.waitForFunction(() => /आर्या/.test(document.querySelector('#main')?.innerText || '') && document.querySelector('.dk-facts'), null, { timeout: 15000 }).catch(() => {});
  ok(/आर्या/.test(await page.locator('#main').innerText()), '🔔 tapping the push opens that family card', (await page.locator('#main').innerText()).slice(0, 200));
  ok(!errs.length, 'no page errors', errs.join(' | '));
  try { await browser?.close(); } catch {} statics.close();
} catch (e) { console.log('CRASH', e && e.stack); fails++;

} finally {
  killStray(); try { execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  graph.close(); render.close();
  if (fails) console.log(log.split('\n').filter(l => /error|Error|✘/.test(l)).slice(-20).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
