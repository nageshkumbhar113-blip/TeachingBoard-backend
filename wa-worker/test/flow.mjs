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
ok(/Monthly ₹200 · Yearly/.test(r.text) && !/→/.test(r.text.split('🔓')[1] || ''), 'after the offer: full price, no offer line', r.text);
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
ok(/उद्या महा-Test नंतर/.test(texts(out)[0]), '✅: "the result will come here tomorrow"', texts(out)[0]);
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

console.log(bad ? `${bad} FAILED` : 'FLOW ALL PASS');
process.exit(bad ? 1 : 0);
