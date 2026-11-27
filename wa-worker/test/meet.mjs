// 📅 Teachers' Sunday live demo (waFlow engine only, simulated clock). node test/meet.mjs
// A (no form id): account → invite at once with 📅 बुक करा → booked + 🎥 Join button → Sat 6 pm + Sun 9:45 Join
//   reminders → 11 am three questions → interested to the Call desk.
// B: never books → asked again the Friday before the next Sunday.  C: window closed on Saturday → the team.
// F (form id set): a new teacher gets the booking form first; the form comes back → booked + Join + accounts asked.
import WA from '../src/waFlow.js';
let fails = 0; const ok = (c, m, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fails++; };
const T = s => new Date(s + '+05:30');
const msgs = out => out.filter(o => o.to === 'wa');
const texts = out => msgs(out).map(o => o.text || '').join(' || ');
const btns = out => msgs(out).flatMap(o => (o.buttons || []));
const ids = out => btns(out).map(b => b.id).filter(Boolean);
const join = out => btns(out).some(b => b.url === 'https://meet.google.com/hsz-addq-znj');
function teacher(booked) {
  const lead = WA.createLead({ gid: 'AAAA111111', name: 'संजय' }, booked);
  lead.tdemo = { via: 'bot', stage: 'making' };
  WA.inbound(lead, 'hi', booked);
  const out = WA.event(lead, 'tdemo', { account: { tCode: 'SAN123', tPin: '7284', sCode: 'JIP0001', sPin: '3916', course: '8th NMMS', until: T('2026-11-29T23:59:59').toISOString() } }, booked);
  return { lead, out };
}
WA.CONFIG.meetFlow = ''; const PAGE = WA.CONFIG.meetPage; WA.CONFIG.meetPage = '';   // A-C: the chat path
let { lead: A, out } = teacher(T('2026-11-27T13:00:00'));
ok(/Live Demo/.test(texts(out)) && /29 नोव्हेंबर/.test(texts(out)) && ids(out).includes('tm:yes'), 'invite at once with the codes: Sunday 29 Nov, 📅 बुक करा', texts(out).slice(-200));
out = WA.inbound(A, 'tm:yes', T('2026-11-27T13:05:00'));
ok(/बुक झालं/.test(texts(out)) && join(out), 'बुक करा → booked + 🎥 Join button with the Meet link', JSON.stringify(btns(out)));
ok(A.tdemo.meet && A.tdemo.meet.for === '2026-11-29', 'booked for 2026-11-29');
WA.inbound(A, 'ok', T('2026-11-28T10:00:00'));
out = WA.tick(A, T('2026-11-28T18:01:00'));
ok(/उद्या सकाळी 10/.test(texts(out)) && join(out) && ids(out).includes('tm:sat'), 'Saturday 6 pm: Join button + "✅ येतो"', texts(out));
WA.inbound(A, 'tm:sat', T('2026-11-28T18:05:00'));
out = WA.tick(A, T('2026-11-29T09:46:00'));
ok(/15 मिनिटांत/.test(texts(out)) && join(out), 'Sunday 9:45: Join button', texts(out));
out = WA.tick(A, T('2026-11-29T11:01:00'));
ok(/कसा वाटला/.test(texts(out)), '11 am questions');
WA.inbound(A, 'tf:good', T('2026-11-29T11:05:00')); WA.inbound(A, 'tf:add', T('2026-11-29T11:06:00'));
out = WA.inbound(A, 'tf:call', T('2026-11-29T11:07:00'));
ok(A.crm === 'call' && /interested/.test(A.tdemo.callWhy || '') && out.some(o => o.action === 'team_push'), 'interested → Call desk 🔥 + team push');
const { lead: B } = teacher(T('2026-11-27T15:00:00'));
WA.inbound(B, 'hi', T('2026-12-04T10:00:00'));
out = WA.tick(B, T('2026-12-04T18:01:00'));
ok(/6 डिसेंबर/.test(texts(out)) && /2 दिवस/.test(texts(out)) && ids(out).includes('tm:yes'), 'not booked → the invite again every evening 6 pm with the days left (Fri 4 Dec: 2 days to Sunday 6 Dec)', texts(out));
WA.inbound(B, 'hi', T('2026-12-05T09:00:00')); out = WA.tick(B, T('2026-12-05T18:01:00'));
ok(/उद्या/.test(texts(out)), 'Saturday evening: "उद्या"', texts(out));
out = WA.tick(B, T('2026-12-05T18:30:00')); ok(!texts(out), 'once a day only');
const { lead: C } = teacher(T('2026-11-27T09:00:00'));
WA.inbound(C, 'tm:yes', T('2026-11-27T09:30:00'));
out = WA.tick(C, T('2026-11-28T18:01:00'));
ok(!texts(out) && C.crm === 'call' && /आठवण/.test(C.tdemo.callWhy || ''), 'Saturday, window closed: the team calls');
// P: our booking page — the invite carries a 📅 बुक करा link with this teacher's own token
WA.CONFIG.meetPage = PAGE;
const P = WA.createLead({ gid: 'PPPP111111' }, T('2026-11-27T16:00:00'));
out = WA.inbound(P, 'teacher', T('2026-11-27T16:00:00'));
const pl = btns(out).find(b => b.url);
ok(pl && /^https:\/\/nkseduorbit\.in\/live-demo\?g=PPPP111111&t=[a-z0-9]{8,24}$/.test(pl.url) && P.tdemo.mtok && pl.url.endsWith(P.tdemo.mtok) && P.tdemo.stage === 'form', 'page: the invite links our page with the token', pl && pl.url);
const mi = WA.meetInfo(P, T('2026-11-27T16:01:00'));
ok(mi.when === 'रविवार, 29 नोव्हेंबर · सकाळी 10:00' && !mi.booked, 'page info: Sunday 29 Nov, not booked', JSON.stringify(mi));
// F: with the booking form
WA.CONFIG.meetFlow = '1234567890';
const F = WA.createLead({ gid: 'FFFF111111' }, T('2026-11-27T16:00:00')); F.courses = ['8th NMMS EXAM 26-27 BATCH', '4th Scholarship'];
out = WA.inbound(F, 'teacher', T('2026-11-27T16:00:00'));
const fb = btns(out).find(b => b.flow);
ok(/जागा बुक करा/.test(texts(out)) && /शिक्षक account/.test(texts(out)) && fb && fb.flow.id === '1234567890' && fb.flow.screen === 'BOOK', 'a new teacher: the booking form first (📅 बुक करा opens the form)', texts(out));
out = WA.inbound(F, 'tform:' + JSON.stringify({ name: 'सुनीता जाधव', school: 'जि. प. शाळा', village: 'कागल', district: 'कोल्हापूर', cls: 'nmms8', students: '21-50' }), T('2026-11-27T16:03:00'));
ok(F.name === 'सुनीता जाधव' && F.tdemo.district === 'कोल्हापूर' && F.tdemo.course === '8th NMMS EXAM 26-27 BATCH' && F.tdemo.students === '21-50', 'form saved: name, school, village, district, class → course, students', JSON.stringify(F.tdemo).slice(0, 200));
ok(F.tdemo.meet && F.tdemo.meet.for === '2026-11-29' && join(out) && /बुक झालं, \*सुनीता जाधव\*/.test(texts(out)), 'booked for Sunday + Join button', texts(out));
const acc = out.find(o => o.action === 'teacher_account');
ok(acc && /कागल/.test(acc.data.school) && acc.data.course === '8th NMMS EXAM 26-27 BATCH' && F.tdemo.stage === 'making', 'accounts asked at once (Render teacher_account)', JSON.stringify(acc));
out = WA.event(F, 'tdemo', { account: { tCode: 'SUN123', tPin: '1111', sCode: 'JIL0001', sPin: '2222', course: '8th NMMS EXAM 26-27 BATCH', until: T('2026-11-29T23:59:59').toISOString() } }, T('2026-11-27T16:04:00'));
ok(/SUN123/.test(texts(out)) && !/जागा बुक करा/.test(texts(out)), 'codes + steps come; no second invite (already booked)', texts(out).slice(0, 160));
const G = WA.createLead({ gid: 'GGGG111111' }, T('2026-11-27T17:00:00'));
WA.inbound(G, 'teacher', T('2026-11-27T17:00:00'));
out = WA.inbound(G, 'राम पवार, नवीन शाळा कागल', T('2026-11-27T17:01:00'));
ok(btns(out).some(b => b.flow), 'typed instead of the form: the form once more');
out = WA.inbound(G, 'राम पवार, नवीन शाळा कागल', T('2026-11-27T17:02:00'));
ok(out.some(o => o.action === 'teacher_account') && G.name === 'राम पवार', 'typed again: that line is the name + school (accounts asked)');
// N: a teacher stopped at the class question (no account) → the booking page invite (and the page makes the account)
WA.CONFIG.meetFlow = ''; WA.CONFIG.meetPage = PAGE;
const N = WA.createLead({ gid: 'NNNN111111' }, T('2026-11-27T11:00:00'));
N.tdemo = { via: 'bot', stage: 'cls', startedAt: T('2026-11-27T11:00:00').toISOString() }; N.lastInboundAt = T('2026-11-27T11:00:00').toISOString();
out = WA.tick(N, T('2026-11-27T16:01:00'));
ok(btns(out).some(b => b.url && /live-demo/.test(b.url)) && N.tdemo.stage === 'form', 'stopped at the class question → the 📅 बुक करा page invite', texts(out));
WA.inbound(N, 'hi', T('2026-11-28T09:00:00'));
out = WA.tick(N, T('2026-11-28T18:01:00'));
ok(/उद्या/.test(texts(out)) && btns(out).some(b => b.url), 'next evening again (उद्या), with the button', texts(out));
// a class that has no Test Series of that name: no wrong course
const C7 = WA.createLead({ gid: 'C7C7111111' }, T('2026-11-27T16:00:00')); C7.courses = ['10वी - Semi English', '8th NMMS EXAM 26-27 BATCH'];
WA.inbound(C7, 'teacher', T('2026-11-27T16:00:00'));
out = WA.inbound(C7, 'tform:' + JSON.stringify({ name: 'अ ब', school: 'शाळा', village: 'गाव', district: 'जिल्हा', cls: 'sch7', students: '1-20' }), T('2026-11-27T16:02:00'));
const jb = out.find(o => o.action === 'teacher_account');
ok(jb && jb.data.course === '', '7वी picked, no 7th course here → no course (Render gives the ad course), never 10वी', JSON.stringify(jb && jb.data));
// 📵 the team got no answer
const Q = WA.createLead({ gid: 'QQQQ111111', name: 'राम' }, T('2026-11-27T16:00:00')); Q.tdemo = { stage: 'steps', tCode: 'RAM1', bookedAt: T('2026-11-27T16:00:00').toISOString() }; Q.lastInboundAt = T('2026-11-27T16:00:00').toISOString();
out = WA.teacherNoAnswer(Q, T('2026-11-27T17:00:00'));
ok(/संपर्क झाला नाही/.test(texts(out)) && /Live Demo/.test(texts(out)) && /8390484545/.test(texts(out)) && btns(out).some(b => b.url && /live-demo/.test(b.url)), 'no answer (not booked): Live Demo + 📅 बुक करा + call 8390484545', texts(out));
Q.tdemo.meet = { for: '2026-11-29', at: 'x' };
out = WA.teacherNoAnswer(Q, T('2026-11-27T17:05:00'));
ok(/बुक आहे/.test(texts(out)) && join(out), 'no answer (booked): "your demo is booked" + Join', texts(out));
out = WA.teacherNoAnswer(Q, T('2026-11-29T18:00:00'));
ok(!texts(out) && out.some(o => o.to === 'log'), 'window closed: nothing sent, the team is told to send it themselves');
console.log(fails ? fails + ' FAILED' : 'ALL PASS');
