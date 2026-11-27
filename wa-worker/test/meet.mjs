// 📅 Teachers' Sunday live demo (waFlow engine only, simulated clock): invite → हो → Sat 6 pm + Sun 9:45 reminders
// with the link → 11 am three questions → interested teacher to the Call desk; "नाही" → asked again next Friday.
// node test/meet.mjs
import WA from '../src/waFlow.js';
let fails = 0; const ok = (c, m, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fails++; };
const T = s => new Date(s + '+05:30');
const texts = out => out.filter(o => o.to === 'wa').map(o => o.text || o.body || '').join(' || ');
const btns = out => out.filter(o => o.to === 'wa').flatMap(o => (o.buttons || []).map(b => b.id));
function teacher(booked) {
  const lead = WA.createLead({ gid: 'AAAA111111', name: 'संजय' }, booked);
  lead.tdemo = { via: 'bot', stage: 'making' };
  WA.inbound(lead, 'hi', booked);   // the teacher wrote (window open)
  WA.event(lead, 'tdemo', { account: { tCode: 'SAN123', tPin: '7284', sCode: 'JIP0001', sPin: '3916', course: '8th NMMS', until: T('2026-11-29T23:59:59').toISOString() } }, booked);
  return lead;
}
const runTo = (lead, at) => WA.tick(lead, at);
// Friday 27 Nov 2026, 1 pm: account made
const A = teacher(T('2026-11-27T13:00:00'));
let out = runTo(A, T('2026-11-27T13:25:00'));
ok(/Live Demo/.test(texts(out)) && /29 नोव्हेंबर/.test(texts(out)) && btns(out).includes('tm:yes'), 'invite 20 min after the codes: this Sunday 29 Nov, ✅ हो / ❌ नाही', texts(out));
out = WA.inbound(A, 'tm:yes', T('2026-11-27T13:30:00'));
ok(/नोंद झाली/.test(texts(out)) && /meet\.google\.com\/hsz-addq-znj/.test(texts(out)), '"हो" → registered, the Meet link', texts(out));
ok(A.tdemo.meet && A.tdemo.meet.for === '2026-11-29', 'registered for 2026-11-29', JSON.stringify(A.tdemo.meet));
WA.inbound(A, 'ok', T('2026-11-28T10:00:00'));   // wrote Saturday morning (window open till Sun 10 am)
out = runTo(A, T('2026-11-28T18:01:00'));
ok(/उद्या सकाळी 10/.test(texts(out)) && /hsz-addq-znj/.test(texts(out)) && btns(out).includes('tm:sat'), 'Saturday 6 pm reminder with the link + "✅ येतो"', texts(out));
out = WA.inbound(A, 'tm:sat', T('2026-11-28T18:05:00'));
ok(/उद्या भेटू/.test(texts(out)), '"येतो" → see you tomorrow');
out = runTo(A, T('2026-11-29T09:46:00'));
ok(/15 मिनिटांत/.test(texts(out)) && /hsz-addq-znj/.test(texts(out)), 'Sunday 9:45 reminder with the link', texts(out));
out = runTo(A, T('2026-11-29T11:01:00'));
ok(/कसा वाटला/.test(texts(out)) && btns(out).includes('tf:good'), '11 am: how was it? 👍 / 🤔', texts(out));
out = WA.inbound(A, 'tf:good', T('2026-11-29T11:05:00'));
ok(btns(out).includes('tf:add'), 'then: add your class? ✅ / ⏳');
out = WA.inbound(A, 'tf:add', T('2026-11-29T11:06:00'));
ok(btns(out).includes('tf:call'), 'then: call you? 📞 / ❌');
out = WA.inbound(A, 'tf:call', T('2026-11-29T11:07:00'));
ok(A.crm === 'call' && /interested/.test(A.tdemo.callWhy || '') && out.some(o => o.action === 'team_push'), 'interested → Call desk 🔥 + team push', A.crm + ' ' + A.tdemo.callWhy);
// a teacher who says "नाही" → asked again on Friday 4 Dec 6 pm for Sunday 6 Dec
const B = teacher(T('2026-11-27T15:00:00'));
runTo(B, T('2026-11-27T15:25:00'));
WA.inbound(B, 'tm:no', T('2026-11-27T15:30:00'));
ok(B.tdemo.meet && B.tdemo.meet.no, '"नाही" noted');
out = runTo(B, T('2026-11-29T09:50:00'));
ok(!/15 मिनिटांत/.test(texts(out)), 'no Sunday reminder for "नाही"');
WA.inbound(B, 'hi', T('2026-12-04T10:00:00'));
out = runTo(B, T('2026-12-04T18:01:00'));
ok(/6 डिसेंबर/.test(texts(out)) && btns(out).includes('tm:yes'), 'asked again Friday 6 pm for Sunday 6 Dec', texts(out));
// window closed on Saturday → the team is told instead
const C = teacher(T('2026-11-27T09:00:00'));
runTo(C, T('2026-11-27T09:25:00')); WA.inbound(C, 'tm:yes', T('2026-11-27T09:30:00'));
out = runTo(C, T('2026-11-28T18:01:00'));
ok(!texts(out) && C.crm === 'call' && /आठवण/.test(C.tdemo.callWhy || ''), 'Saturday, window closed: no message, the team calls', texts(out) + ' | ' + C.tdemo.callWhy);
console.log(fails ? fails + ' FAILED' : 'ALL PASS');
