// Pure rule checks for waFlow.js (no Worker, no network): the website's LINK-with-name and "next test" paths.
import { createRequire } from 'module';
const W = createRequire(import.meta.url)('../src/waFlow.js');
let bad = 0;
const ok = (c, name, got) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}${c ? '' : '  ' + String(got).slice(0, 300)}`); if (!c) bad++; };
const texts = out => out.filter(x => x.to === 'wa').map(x => x.text);
const now = new Date('2026-11-10T13:00:00Z');   // a Tuesday, 6:30 pm IST

// 1) the parent typed the child's name on the website: LINK <gid> <name> → the link at once, no question
let lead = W.createLead({ gid: 'AAAA111111', name: '', cls: '8th', freeTotal: 18 }, now);
let out = W.inbound(lead, 'LINK AAAA111111 राहुल', now);
ok(out.some(x => x.to === 'do' && x.action === 'lead'), 'LINK: the number becomes a lead');
ok(out.some(x => x.to === 'do' && x.action === 'name' && x.name === 'राहुल'), 'LINK: the name goes to Render');
let t = texts(out);
ok(t.length === 2 && /forward/.test(t[0]) && /^राहुल, तुझी free test/.test(t[1]) && /free=1&g=AAAA111111/.test(t[1]), 'LINK: a note, then the child\'s own message to forward', t.join(' | '));
ok(!t.some(x => /नाव काय/.test(x)), 'LINK with a name: the name is not asked again');

// 2) LINK without a name still asks for it, and the answer gives the same two messages
lead = W.createLead({ gid: 'CCCC111111', name: '', cls: '8th', freeTotal: 18 }, now);
t = texts(W.inbound(lead, 'LINK CCCC111111', now));
ok(t.length === 1 && /नाव काय/.test(t[0]), 'LINK without a name: asks the name', t.join(' | '));
t = texts(W.inbound(lead, 'Sai', now));
ok(t.length === 2 && /^Sai, तुझी free test/.test(t[1]), 'the name answer: the child\'s message to forward', t.join(' | '));

// 3) the website's "next test" button after the first test: TEST <gid> as the first message
lead = W.createLead({ gid: 'BBBB111111', name: 'Sai', cls: '8th', freeTotal: 18 }, now);
W.event(lead, 'test_done', { n: 1, score: 7, total: 10 }, now);
out = W.inbound(lead, 'TEST BBBB111111', now);
t = texts(out);
ok(out.some(x => x.to === 'do' && x.action === 'lead'), 'TEST first contact: the number becomes a lead');
ok(/पूर्ण result/.test(t[0]) && /7\/10/.test(t[0]), 'TEST first contact: the result first', t[0]);
ok(t.some(x => /रोज 1 free test WhatsApp वर पाठवू/.test(x)), 'TEST first contact: asks the daily time');
ok(!t.some(x => /आजची free test \(/.test(x)), 'TEST first contact: no second test the same day');

// 4) one test a day wherever it was taken: a website test today → TEST says "today's is done"
t = texts(W.inbound(lead, 'TEST', now));
ok(/आजची free test झाली आहे/.test(t[0]), 'TEST after today\'s website test → "today\'s is done"', t[0]);

// 5) the next day TEST gives the next link
const tomorrow = new Date(now.getTime() + 24 * 3600e3);
t = texts(W.inbound(lead, 'TEST', tomorrow));
ok(/आजची free test \(2\/18\)/.test(t[0]) && /free=1&g=BBBB111111/.test(t[0]), 'the next day: the next test link', t[0]);


// 6) the unlock line: the child's course, total tests, price with the offer, the pay link; three buttons
lead = W.createLead({ gid: 'DDDD111111', name: 'Om', cls: '8th NMMS', freeTotal: 18, totalTests: 284, prices: { monthly: 200, yearly: 1500 } }, now);
W.event(lead, 'sync', { prices: { monthly: 200, yearly: 1500 } }, now);
W.event(lead, 'test_done', { n: 1, score: 8, total: 10 }, now);
out = W.inbound(lead, 'RESULT DDDD111111', now);
let r = out.find(x => x.to === 'wa');
ok(r.text.includes('🔓 *8th NMMS course* — Om साठी') && r.text.includes('सगळे 284 tests (आत्ता 18 free)') && r.text.includes('parent-pay.html?g=DDDD111111'), 'result: the unlock line with the course, 284 tests and the pay link', r.text);
ok(/Monthly ₹200 → ₹100/.test(r.text) && /50% सूट/.test(r.text), 'unlock line: offer price while the offer runs', r.text);
ok(JSON.stringify(r.buttons.map(b => b.id)) === '["pay","ask","call_me"]', 'result buttons: Unlock / प्रश्न / Call', JSON.stringify(r.buttons));
const later = new Date(now.getTime() + 30 * 3600e3);
W.inbound(lead, 'hi', later);
out = W.event(lead, 'test_done', { n: 2, score: 9, total: 10 }, later);
r = out.find(x => x.to === 'wa');
ok(r.text.includes('Monthly ₹200 → ₹140') && r.text.includes('30% सूट'), 'the day after: the second step (30 %)', r.text);
ok(r.buttons.some(b => b.id === 'pay'), 'after the offer the Unlock button stays');

// 7) MAHA from the website after the महा-Test: the window opens, the result + rank + unlock come when ready
lead = W.createLead({ gid: 'EEEE111111', name: 'Riya', cls: '8th NMMS', freeTotal: 18, totalTests: 284, prices: { monthly: 200 } }, now);
W.event(lead, 'test_done', { n: 1, score: 5, total: 10 }, now);
const sun = new Date('2026-11-15T05:30:00Z');   // Sunday 11 am IST
out = W.inbound(lead, 'MAHA EEEE111111', sun);
ok(out.some(x => x.to === 'do' && x.action === 'lead') && /महा-Test जमा झाला/.test(texts(out)[0]), 'MAHA: lead + "result will come here"', texts(out)[0]);
out = W.event(lead, 'mt_result', { score: 24, total: 30, rank: 12, of: 340 }, new Date(sun.getTime() + 3600e3));
r = out.find(x => x.to === 'wa');
ok(r && r.text.includes('24/30') && r.text.includes('#12') && r.text.includes('maha-test.html?class=8th%20NMMS') && r.text.includes('🔓'), 'महा-Test result: marks, rank, Top 10 page, unlock', r && r.text);
ok(lead.mtLast && lead.mtLast.rank === 12, 'the महा-Test result is kept for the CRM');

// 8) the evening before the महा-Test: "result on WhatsApp?" (only with an open window), ✅ keeps it open
lead = W.createLead({ gid: 'FFFF111111', name: 'Om', cls: '8th', freeTotal: 18, mtNext: '2026-11-15T04:30:00Z' }, now);   // Sunday 10 am IST
W.event(lead, 'test_done', { n: 1, score: 5, total: 10 }, now);
const sat = new Date('2026-11-14T14:00:00Z');   // Saturday 7:30 pm IST
W.inbound(lead, 'hi', sat);
const due = W.nextDue(lead, sat);
const satAsk = W.tick(lead, new Date('2026-11-14T15:01:00Z'));   // 8:31 pm
const ask = satAsk.find(x => x.to === 'wa' && /महा-Test/.test(x.text));
ok(ask && ask.buttons.some(b => b.id === 'mt_want'), 'Saturday 8:30 pm: "result on WhatsApp?" with ✅', JSON.stringify(satAsk.map(x => x.text || x.what)));
out = W.inbound(lead, 'mt_want', new Date('2026-11-14T15:05:00Z'));
ok(/✅ ठीक आहे! महा-Test नंतर/.test(texts(out)[0]), '✅: "the result will come here after the महा-Test"', texts(out)[0]);
const rem = W.tick(lead, new Date('2026-11-15T04:01:00Z'));   // 9:31 am
ok(rem.some(x => x.to === 'wa' && /महा-Test/.test(x.text)), 'Sunday 9:30: the reminder 30 minutes before', JSON.stringify(rem.map(x => x.text || x.what)));

// 9) the offer reminder 3 h before the end (window open)
lead = W.createLead({ gid: 'GGGG111111', name: 'Om', cls: '8th', freeTotal: 18, prices: { monthly: 200 } }, now);
W.event(lead, 'test_done', { n: 1, score: 5, total: 10 }, now);
W.inbound(lead, 'RESULT GGGG111111', now);
W.inbound(lead, 'hi', new Date(now.getTime() + 18 * 3600e3));
const end = new Date(lead.offerEnd);
out = W.tick(lead, new Date(end.getTime() - 3 * 3600e3 + 60e3));
ok(out.some(x => x.to === 'wa' && /3 तासांत संपेल/.test(x.text)), 'offer: one reminder 3 hours before the end', JSON.stringify(out.map(x => x.text || x.what)));

// 10) two-step offer: 50 % for 24 h, then 30 % until the first Sunday 11 pm, then the full price
lead = W.createLead({ gid: 'HHHH111111', name: 'Om', cls: '8th NMMS', freeTotal: 18 }, now);
W.event(lead, 'sync', { prices: { monthly: 200 } }, now);
W.event(lead, 'test_done', { n: 1, score: 5, total: 10 }, now);              // Tuesday 6:30 pm → 50 % until Wednesday 6:30 pm
const thu = new Date('2026-11-12T08:00:00Z');                                 // Thursday 1:30 pm
out = W.inbound(lead, 'RESULT HHHH111111', thu);
r = out.find(x => x.to === 'wa');
ok(r.text.includes('Monthly ₹200 → ₹140') && r.text.includes('30% सूट') && /रविवारी रात्री 11/.test(r.text), 'after 24 h: 30 % until Sunday 11 pm', r.text);
const mon = new Date('2026-11-16T08:00:00Z');                                 // Monday
W.inbound(lead, 'hi', mon);
out = W.event(lead, 'test_done', { n: 2, score: 6, total: 10 }, mon);
r = out.find(x => x.to === 'wa');
ok(r && !/सूट/.test(r.text) && r.text.includes('Monthly ₹200') && !r.text.includes('→'), 'after Sunday: the full price', r && r.text);
lead = W.createLead({ gid: 'IIII111111', name: 'Om', cls: '8th', freeTotal: 18 }, now);
W.event(lead, 'sync', { prices: { monthly: 200 } }, now);
W.event(lead, 'test_done', { n: 1, score: 5, total: 10 }, now);
W.inbound(lead, 'RESULT IIII111111', now);
W.inbound(lead, 'hi', new Date(now.getTime() + 18 * 3600e3));
out = W.tick(lead, new Date(new Date(lead.offerEnd).getTime() - 3 * 3600e3 + 60e3));
r = out.find(x => x.to === 'wa' && /3 तासांत/.test(x.text));
ok(r && /त्यानंतर .*30%/.test(r.text), 'the 3-hour reminder says what comes next (30 % until Sunday)', r && r.text);

// 2026-11-08: the free account (code + PIN) in the messages; at most 2 tests on WhatsApp, then the app or the course
lead = W.createLead({ gid: 'JJJJ111111', name: 'Riya', cls: '8th', freeTotal: 18 }, now);
W.event(lead, 'form_number', {}, now);
W.event(lead, 'sync', { acct: { code: 'STU123', pin: '5307' }, prices: { monthly: 200 } }, now);
ok(lead.crm === 'form' && lead.acct.code === 'STU123', 'number from the website: form list, the account kept');
W.event(lead, 'test_done', { n: 1, score: 6, total: 10 }, now);
t = texts(W.inbound(lead, 'RESULT JJJJ111111', now));
ok(t[0].includes('STU123') && t[0].includes('5307') && t[0].includes('play.google.com'), 'RESULT answer: code, PIN and the app link', t[0]);
const d1 = new Date(now.getTime() + 24 * 3600e3), d2 = new Date(now.getTime() + 48 * 3600e3), d3 = new Date(now.getTime() + 72 * 3600e3);
t = texts(W.inbound(lead, 'TEST', d1));
ok(/आजची free test \(2\/18\)/.test(t[0]), 'WhatsApp test 1', t[0]);
W.event(lead, 'test_done', { n: 2, score: 7, total: 10 }, d1);
t = texts(W.inbound(lead, 'TEST', d2));
ok(/आजची free test \(3\/18\)/.test(t[0]), 'WhatsApp test 2', t[0]);
W.event(lead, 'test_done', { n: 3, score: 7, total: 10 }, d2);
const d3b = new Date(d3.getTime() + 3600e3);
out = W.inbound(lead, 'TEST', d3b);
t = texts(out);
ok(t.length >= 1 && /2 free tests झाल्या/.test(t[0]) && t[0].includes('STU123') && t[0].includes('parent-pay.html') && !/free=1&g=/.test(t[0]), 'after 2 on WhatsApp: app (code + PIN) or the course, no third link', t[0]);
ok(out.find(x => x.to === 'wa').buttons.map(b => b.id).join() === 'app,pay,call_me', 'buttons: App · Course · Call');
t = texts(W.inbound(lead, 'app', d3b));
ok(/Code: \*STU123\*/.test(t[0]), 'the App button: login with code + PIN', t[0]);
// a lead already talking on WhatsApp is not pulled back to the form list (backfill / a second number)
W.event(lead, 'form_number', { backfill: true }, d3b);
ok(lead.crm !== 'form', 'backfill never pulls a lead talking on WhatsApp back to the form list', lead.via + ' ' + lead.crm);
lead = W.createLead({ gid: 'KKKK111111', name: 'Om', cls: '8th', freeTotal: 18 }, now);
W.event(lead, 'form_number', { backfill: true }, now);
ok(lead.via === 'form' && lead.crm === 'form', 'backfill: an old website number goes to the form list');
ok(W.event(lead, 'form_number', { backfill: true }, now).length === 0, 'backfill twice: nothing new');

// 2026-11-12: a family from a click-to-WhatsApp ad (72 h free), or a new number writing "hi"
const thuAd = new Date('2026-11-12T06:30:00Z');   // Thursday noon IST
lead = W.createLead({ gid: 'CTWA111111' }, thuAd);
lead.mobile = '9822200041'; lead.ctwaUntil = new Date(thuAd.getTime() + 72 * 3600e3).toISOString();
W.event(lead, 'sync', { cls: '', courses: ['8th NMMS EXAM 26-27 BATCH', '10th'], mtNext: '2026-11-15T04:30:00Z', freeTotal: 18 }, thuAd);
out = W.welcome(lead, 'Hello! Can I get more info on this?', thuAd);
let wm = out.find(x => x.to === 'wa');
ok(wm && /कोणत्या class/.test(wm.text) && wm.buttons.length === 2 && wm.buttons[0].id === 'cls:0', 'ad, no class known: the class is asked (list)', wm && wm.text);
out = W.inbound(lead, 'cls:0', new Date(thuAd.getTime() + 60e3));
t = texts(out);
ok(lead.cls === '8th NMMS EXAM 26-27 BATCH' && out.some(x => x.to === 'do' && x.action === 'batch' && x.data.batch === lead.cls) && t.some(x => /free=1&g=CTWA111111/.test(x)) && !t.some(x => /नाव लिहा/.test(x)) && !lead.awaiting, 'class chosen → Render told, the test link at once (no name asked)', t.join(' | '));
ok(t.some(x => /forward/.test(x)) && t.some(x => /महा-Test/.test(x) && /नोंदणी करू/.test(x)), 'forward note + the महा-Test registration asked at once', t.join(' | '));
// the child types the name on the website → Render: the name and the free account
out = W.event(lead, 'sync', { name: 'Atharv', acct: { code: 'ATH201', pin: '4826' } }, new Date(thuAd.getTime() + 180e3));
ok(texts(out).some(x => x.includes('ATH201') && x.includes('4826') && x.includes('play.google.com')), 'the free account arrives → one message with Code + PIN', texts(out).join(' | '));
ok(texts(W.event(lead, 'sync', { acct: { code: 'ATH201', pin: '4826' } }, new Date(thuAd.getTime() + 200e3))).length === 0, 'the account message only once');
// still open after 24 h (ad window 72 h), the reminders inside it
const fri = new Date('2026-11-13T13:31:00Z');   // Friday 7:01 pm IST, 31 h after the message
ok(W.isOpen(lead, fri), 'window still open after 31 h (ad: 72 h)');
out = W.tick(lead, fri);
ok(texts(out).some(x => /free test दिली का/.test(x) && x.includes('g=CTWA111111')), 'next evening: "did the child take the test?"', texts(out).join(' | '));
let ev7 = out.find(x => /free test दिली का/.test(x.text || ''));
ok(/50% सूट/.test(ev7.text) && ev7.text.includes('parent-pay.html?g=CTWA111111') && ev7.buttons.map(x => x.id).join() === 'got,pay,call_me', 'it also says: test → 50 % off → course, with the pay link and 💳 button', ev7.text);
ok(ev7.text.length < 600, 'the message stays short', ev7.text.length);
out = W.tick(lead, new Date('2026-11-14T15:01:00Z'));   // Saturday 8:31 pm
ok(texts(out).some(x => /उद्या .*महा-Test/.test(x)), 'Saturday evening: the महा-Test question (inside the 72 h)', texts(out).join(' | '));
out = W.tick(lead, new Date('2026-11-15T03:31:00Z'));   // Sunday 9:01 am, window ends at noon
let endMsg = out.find(x => /course घ्यायचा आहे का/.test(x.text || ''));
ok(endMsg && endMsg.text.includes('parent-pay.html?g=CTWA111111') && endMsg.buttons.map(x => x.id).join() === 'keep,pay,call_me', 'near the end of the 72 h: "take the course?" + link, keep the reminders', texts(out).join(' | '));
out = W.tick(lead, new Date('2026-11-15T04:01:00Z'));   // 9:31 am
ok(texts(out).some(x => /महा-Test/.test(x)), 'Sunday 9:31: the महा-Test reminder still free', texts(out).join(' | '));
ok(!W.isOpen(lead, new Date('2026-11-15T07:00:00Z')), 'after 72 h the window is closed');
t = texts(W.inbound(lead, 'keep', new Date('2026-11-15T05:00:00Z')));
ok(/आठवण इथेच येईल/.test(t[0]) && W.isOpen(lead, new Date('2026-11-16T04:00:00Z')), '"keep" → the window again for 24 h', t[0]);
// a plain "hi" from a new number with the class known: the name straight away, 24 h only
lead = W.createLead({ gid: 'HIHI111111' }, thuAd); lead.mobile = '9822200042';
W.event(lead, 'sync', { cls: '10th', courses: ['10th'] }, thuAd);
t = texts(W.welcome(lead, 'hi', thuAd));
ok(t.some(x => /10th ची free test/.test(x) && /g=HIHI111111/.test(x)) && !lead.awaiting && !W.isOpen(lead, new Date(thuAd.getTime() + 25 * 3600e3)), 'a new number ("hi"), class known: the link at once; 24 h window', t.join(' | '));
ok(W.tick(lead, new Date(thuAd.getTime() + 31 * 3600e3)).length === 0, 'not from an ad: no reminders of its own');
lead = W.createLead({ gid: 'ADAD111111' }, thuAd); lead.mobile = '9822200043'; lead.ctwaUntil = new Date(thuAd.getTime() + 72 * 3600e3).toISOString();
W.event(lead, 'sync', { cls: '8th NMMS', courses: ['8th NMMS', '10th'] }, thuAd);
t = texts(W.welcome(lead, 'Hello! Can I get more info on this?', thuAd));
ok(/स्वागत/.test(t[0]) && t.some(x => /8th NMMS ची free test/.test(x) && /g=ADAD111111/.test(x)) && !t.some(x => /class साठी\?|नाव लिहा/.test(x)), 'ad with its class: the class test link straight away, no question', t.join(' | '));
t = texts(W.tick(lead, new Date('2026-11-13T13:31:00Z')));
ok(t.some(x => /पाल्याने free test दिली का/.test(x)), 'no name yet: "पाल्याने free test दिली का?"', t.join(' | '));

console.log(bad ? `${bad} FAILED` : 'FLOW ALL PASS');
process.exit(bad ? 1 : 0);
