// Checks for the bot plan of 2026-11-25 (owner): Test Series wording + facts, link buttons (cta_url),
// the paid family (one message with amount / Code / PIN / Login, "pay kel" and screenshots), no false promises,
// "call nko", "free aahe ka", 3 buttons at most. Pure rules + meta.js bodies; no network.
import { createRequire } from 'module';
import { bodiesFor } from '../src/meta.js';
const W = createRequire(import.meta.url)('../src/waFlow.js');
let bad = 0;
const ok = (c, name, got) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}${c ? '' : '  ' + String(got).slice(0, 400)}`); if (!c) bad++; };
const was = out => out.filter(x => x.to === 'wa');
const texts = out => was(out).map(x => x.text);
const urls = out => was(out).flatMap(x => (x.buttons || []).filter(b => b.url).map(b => b.url));
const now = new Date('2026-11-26T05:30:00Z');   // Thu 11:00 IST
W.CONFIG.teamNumber = '918390484545';
const SERIES = { name: '8वी NMMS', kind: 'exam', short: '2021 पासूनचे पेपर · pattern नुसार प्रश्न + स्पष्टीकरण · रोज test · महा-Test',
  lines: ['📄 2021 पासूनचे मागचे पेपर (2021, 2022, 2023, 2024, 2025) — test म्हणून सोडवता येतात', '🧠 मागच्या पेपरचा अभ्यास करून त्याच pattern चे नवीन प्रश्न · प्रत्येक प्रश्नाचं स्पष्टीकरण',
    '⏰ सोम–शनि सकाळी 7 MAT (90 गुण) · सोम–शनि संध्याकाळी 7 SAT (90 गुण)', '🏆 दर रविवारी संध्याकाळी 7 महा-Test (180 गुण) — सगळ्यांमध्ये rank', '🧑‍🏫 Digital Teacher — रोज काय अभ्यास करायचा ते सांगतो', '💳 ₹149/महिना · ₹499 वर्षभर (30 एप्रिलपर्यंत)'] };
function fam(gid, extra = {}) {
  const l = W.createLead({ gid }, now);
  W.event(l, 'sync', { name: 'सई', cls: '8th NMMS EXAM 26-27 BATCH', kind: 'exam', freeTotal: 20, totalTests: 300, prices: { monthly: 149, yearly: 499 }, series: SERIES, acct: { code: 'SAI368', pin: '3012' }, ...extra }, now);
  l.lastInboundAt = now.toISOString(); l.via = 'wa'; l.mobile = '9800000001';
  return l;
}

// ── the paid family ──
let L = fam('PAID000001');
let out = W.event(L, 'paid', { code: 'SAI368', amount: 349, period: 'yearly', till: '2027-04-30T00:00:00Z', pay_id: 'pay_1' }, now);
let t = texts(out);
ok(t.length === 1 && /₹349/.test(t[0]) && /Yearly/.test(t[0]) && /30\/4\/2027/.test(t[0]) && /SAI368/.test(t[0]) && /\*3012\*/.test(t[0]) && /Login/.test(t[0]) && /Digital Teacher/.test(t[0]) && /Analytics/.test(t[0]), 'paid: one message — amount, plan, till, Code, PIN, Login steps, the app features', t[0]);
ok(urls(out).length === 1 && /play.google.com/.test(urls(out)[0]), 'paid: the 📲 App Download button', JSON.stringify(urls(out)));
ok(texts(W.event(L, 'paid', { code: 'SAI368', amount: 349, period: 'yearly', pay_id: 'pay_1' }, new Date(now.getTime() + 2000))).length === 0, 'paid reported again (verify + webhook): no second message');
ok(texts(W.event(L, 'paid', { code: 'SAI368' }, new Date(now.getTime() + 3000))).length === 0, 'paid reported without an id soon after: no second message');
out = W.inbound(L, 'fee', new Date(now.getTime() + 60e3));
ok(/payment मिळालं आहे/.test(texts(out)[0]) && !urls(out).some(u => /parent-pay/.test(u)), 'paid + "fee": "payment मिळालं", never a pay button', texts(out)[0]);
out = W.inbound(L, 'Pay kel aahe kal', new Date(now.getTime() + 120e3));
ok(/payment मिळालं आहे/.test(texts(out)[0]) && /SAI368/.test(texts(out)[0]), 'paid + "Pay kel aahe kal": yes, with the account', texts(out)[0]);
out = W.inbound(L, '[image]', new Date(now.getTime() + 180e3));
ok(/payment मिळालं आहे/.test(texts(out)[0]), 'paid + a screenshot: yes, with the account', texts(out)[0]);
out = W.inbound(L, 'TEST', new Date(now.getTime() + 240e3));
ok(/Test Series चालू आहे/.test(texts(out)[0]) && /Login/.test(texts(out)[0]), 'paid + TEST: the Test Series is on, log in', texts(out)[0]);

// ── "pay kel" when the payment is not seen yet: the team, at once ──
L = fam('PAID000002');
out = W.inbound(L, 'Payment done', now);
ok(/payment दिसत नाही/.test(texts(out)[0]) && L.crm === 'call' && L.payIssueAt && out.some(x => x.to === 'log' && x.tag === 'PAY' && /दिसत नाही/.test(x.text)), 'unpaid + "Payment done": the team checks (call list, PAY log)', texts(out)[0]);
L = fam('PAID000003'); L.payWantAt = now.toISOString();
out = W.inbound(L, '[image]', now);
ok(/payment दिसत नाही/.test(texts(out)[0]), 'a screenshot after asking for the pay page = "I paid"', texts(out)[0]);
L = fam('PIC0000001');
out = W.inbound(L, '[image]', now);
ok(!texts(out).some(x => /समजलं नाही/.test(x)) && out.some(x => x.to === 'log' && x.tag === 'Q'), 'a photo out of the blue: to the team, never "समजलं नाही"', texts(out).join(' | '));
out = W.inbound(L, '[audio]', new Date(now.getTime() + 60e3));
ok(!texts(out).some(x => /समजलं नाही/.test(x)), 'a voice note: to the team, never "समजलं नाही"', texts(out).join(' | '));

// ── call nko / free? ──
L = fam('NOCALL0001'); L.crm = 'call';
out = W.inbound(L, 'Call nko', now);
ok(L.noCall === true && L.crm === null && /call करणार नाही/.test(texts(out)[0]), '"Call nko": off the call list, told so', texts(out)[0]);
L = fam('FREE000001');
out = W.inbound(L, 'free aahe ka', now);
ok(/1 demo test मोफत/.test(texts(out)[0]) && /फी/.test(texts(out)[0]) && urls(out).some(u => /parent-pay/.test(u)), '"free aahe ka": one clear line (demo free, the Test Series paid) + 💳 Pay', texts(out)[0]);

// ── ℹ️ पूर्ण माहिती: the Test Series facts from the server ──
L = fam('INFO000001');
out = W.inbound(L, 'info', now);
t = texts(out);
ok(/8वी NMMS Test Series/.test(t[0]) && /2021 पासूनचे मागचे पेपर/.test(t[0]) && /90 गुण/.test(t[0]) && /pattern/.test(t[0]) && !/Notes/.test(t[0]) && urls(out)[0].includes('parent-pay'), 'ℹ️: the Test Series facts (papers since 2021, 90 marks daily, pattern), no Notes, 💳 Pay', t[0]);
ok(urls(out).some(u => /play.google.com.*referrer=guest%3DINFO000001|play.google.com/.test(u)) && t.length === 2, 'ℹ️ without the app: then the 📲 App message', t.join(' | '));

// ── no false promise; regular class to the app ──
L = W.createLead({ gid: 'REG0000001' }, now);
W.event(L, 'sync', { name: 'ओम', cls: '10th - Semi English', kind: 'regular', freeLessons: 5, prices: { monthly: 149, yearly: 499 }, courses: ['10th - Semi English'] }, now);
out = W.inbound(L, 'TEST', now);
t = texts(out);
ok(!t.some(x => /रोज 1|इथे पाठवू|कोणत्या वेळी/.test(x)) && t.some(x => /app मध्ये/.test(x)) && /10वी - Semi English Test Series/.test(t.join()), 'regular class: no "a lesson here every day" promise, no time question → the app', t.join(' | '));
L = fam('NEXT000001');
out = W.inbound(L, 'next', now);
ok(!/उद्या/.test(texts(out)[0]) && /app मध्ये/.test(texts(out)[0]), '"next": no "उद्या पाठवतो" — the tests are in the app', texts(out)[0]);

// ── at most 3 reply buttons (a 4th hides them in a list) ──
L = fam('BTN0000001'); L.firstTestAt = now.toISOString(); L.offerEnd = new Date(now.getTime() + 24 * 3600e3).toISOString(); L.testsDone = 1;
const all = [];
for (let h = 0; h < 72; h += 0.5) all.push(...W.tick(L, new Date(now.getTime() + h * 3600e3)));
all.push(...W.inbound(L, 'hi', new Date(now.getTime() + 73 * 3600e3)));
const big = was(all).filter(x => (x.buttons || []).filter(b => !b.url).length > 3);
ok(!big.length, 'no message with more than 3 reply buttons', big.map(x => x.text.slice(0, 40)).join(' | '));
const quiz = was(all).find(x => /आजचा प्रश्न/.test(x.text));
ok(quiz && quiz.buttons.length === 3, 'the morning question: 3 options', quiz && JSON.stringify(quiz.buttons));
ok(!was(all).some(x => /course/i.test(x.text)), 'no "course" word to parents (Test Series)', was(all).filter(x => /course/i.test(x.text)).map(x => x.text.slice(0, 60)).join(' | '));
ok(!was(all).some(x => /https?:\/\/\S*parent-pay/.test(x.text)), 'no raw pay link in the text (the 💳 button instead)', was(all).filter(x => /parent-pay/.test(x.text)).map(x => x.text.slice(0, 60)).join(' | '));

// ── button taps do not use up the day's replies ──
L = fam('TAP0000001');
for (let i = 0; i < 12; i++) W.inbound(L, i % 2 ? 'info' : 'ask', new Date(now.getTime() + i * 60e3));
ok(!L.rCapped, '12 button taps: the bot still answers (taps are not "messages")', L.rN);

// ── meta.js: the link button goes as WhatsApp cta_url ──
let b = bodiesFor('919800000001', 'Pay करा 👇', [{ url: 'https://nkseduorbit.in/parent-pay.html?g=X', label: '💳 50% सूट — Pay करा' }]);
ok(b.length === 1 && b[0].interactive.type === 'cta_url' && b[0].interactive.action.parameters.url.includes('parent-pay') && [...b[0].interactive.action.parameters.display_text].length <= 20, 'cta_url body: one link button, label ≤ 20', JSON.stringify(b));
b = bodiesFor('919800000001', 'x', [{ url: 'https://nkseduorbit.in/', label: '📲 App Download' }, { id: 'ask', label: '❓ प्रश्न' }]);
ok(b.length === 2 && b[0].interactive.type === 'cta_url' && b[1].interactive.type === 'button', 'link + reply buttons: two messages', JSON.stringify(b.map(x => x.interactive.type)));
b = bodiesFor('919800000001', 'x'.repeat(1500), [{ url: 'https://nkseduorbit.in/', label: '💳 Pay करा' }]);
ok(b.length === 2 && b[0].type === 'text' && b[1].interactive.body.text === '👇', 'a long text: the text first, then the button', b.length);
ok(W.cleanName('8th NMMS EXAM 26-27 BATCH') === '8वी NMMS' && W.cleanName('4th Scholarship') === '4थी Scholarship', 'names: 8वी NMMS, 4थी Scholarship');

console.log(bad ? `${bad} FAILED` : 'PLAN 11-25 ALL PASS');
process.exit(bad ? 1 : 0);
