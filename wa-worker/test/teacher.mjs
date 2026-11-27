// 👩‍🏫 Teacher Guide (waFlow.js, owner 2026-11-26) — the rules alone, with a clock we move: run `node test/teacher.mjs`
import { createRequire } from 'module';
const W = createRequire(import.meta.url)('../src/waFlow.js');
W.CONFIG.meetPage = '';   // the chat path (the booking page has its own tests: meet.mjs, meet-page.mjs)
let fails = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + extra)); if (!c) fails++; };
const H = 3600e3;
const T0 = new Date('2026-11-27T05:00:00Z');   // 10:30 IST
const at = h => new Date(T0.getTime() + h * H);
const was = outs => outs.filter(o => o.to === 'wa');
const txt = outs => was(outs).map(o => o.text).join('\n---\n');
const btns = outs => was(outs).flatMap(o => o.buttons || []).map(b => b.id);
const COURSES = ['8th NMMS EXAM 26-27 BATCH', '4th Scholarship', '7th Scholarship'];
const tick = (lead, now) => W.tick(lead, now);
const FREE_WORD = /free|फ्री|मोफत|commission|कमाई/i;

// 1) a parent's welcome offers "👩‍🏫 मी शिक्षक"; the button starts the teacher's flow
let L = W.createLead({ gid: 'AAAA000001', courses: COURSES }, T0); L.mobile = '9822000001';
let o = W.welcome(L, 'hi', T0);
ok(btns(o).includes('teacher') && btns(o).includes('cls:0'), 'parent welcome: the classes + "👩‍🏫 मी शिक्षक"', JSON.stringify(btns(o)));
o = W.inbound(L, 'teacher', at(0.01));
ok(L.tdemo && L.tdemo.stage === 'cls' && btns(o).includes('tcls:0') && /शिक्षक account/.test(txt(o)) && /रविवारपर्यंत/.test(txt(o)), 'मी शिक्षक → teacher account + student account till Sunday offered, the class asked', txt(o));
o = W.inbound(L, 'tcls:0', at(0.02));
ok(L.tdemo.course === COURSES[0] && L.tdemo.stage === 'name' && /नाव आणि शाळा/.test(txt(o)), 'class tapped → name + school asked');
o = W.inbound(L, 'संजय पाटील, जि. प. शाळा कागल', at(0.03));
const job = o.find(x => x.to === 'do' && x.action === 'teacher_account');
ok(job && job.name === 'संजय पाटील' && job.data.school === 'जि. प. शाळा कागल' && job.data.course === COURSES[0] && L.tdemo.stage === 'making', 'name line → Render asked for the accounts (name, school, class)', JSON.stringify(job));
// Render's answer
o = W.event(L, 'tdemo', { account: { tCode: 'SAN123', tPin: '7284', sCode: 'JIP0001', sPin: '3916', course: COURSES[0], until: at(72).toISOString() } }, at(0.05));
let t = txt(o);
ok(/SAN123/.test(t) && /7284/.test(t) && /JIP0001/.test(t) && /3916/.test(t) && /रविवार/.test(t) && /विद्यार्थी account/.test(t), 'codes: teacher + student account (till Sunday)', t);
ok(/Step 1\/7/.test(t) && /teacher-guide#login/.test(t) && btns(o).includes('ts:done') && btns(o).includes('ts:help'), 'Step 1 with its guide link and ✅ / ❓', t);
ok(o.some(x => x.to === 'do' && x.action === 'team_push' && /नवीन शिक्षक/.test(x.data.title)), 'team push: 🆕 नवीन शिक्षक');
ok(!FREE_WORD.test(t), 'no free / commission words', t.match(FREE_WORD));
// the app says: login → step 2 by itself
o = W.event(L, 'tdemo', { tLogin: true }, at(0.2));
ok(L.tdemo.step === 1 && /Step 2\/7/.test(txt(o)) && /teacher-guide#paper/.test(txt(o)), 'app: login → Step 2 (paper) by itself', txt(o));
// ✅ on paper (the app did not say yet) → step 3
o = W.inbound(L, 'ts:done', at(0.3));
ok(L.tdemo.step === 2 && /Step 3\/7/.test(txt(o)), '✅ झालं → Step 3', txt(o));
// a later step done early in the app (the demo student's test) is skipped when its turn comes
W.event(L, 'tdemo', { sTest: true }, at(0.35));
o = W.inbound(L, 'ts:done', at(0.4));
ok(L.tdemo.step === 4 && /Step 5\/7/.test(txt(o)) && !/Step 4\/7/.test(txt(o)), 'the demo test already done → Step 4 skipped, Step 5 next', txt(o));
// ❓ अडचण → asked to write; a question → the AI / the team (qa)
o = W.inbound(L, 'ts:help', at(0.5));
ok(/काय अडचण/.test(txt(o)), '❓ → "काय अडचण आहे?"');
o = W.inbound(L, 'Analytics मध्ये गुण दिसत नाहीत', at(0.51));
ok(o.some(x => x.qa && x.qa.teacher && x.to === 'log') && o.some(x => x.qa && x.to === 'wa'), 'a question → for the AI (teacher facts), team otherwise');
// no reply limit for teachers
for (let i = 0; i < 12; i++) o = W.inbound(L, 'प्रश्न ' + i + ' Paper कसा बनवायचा?', at(0.6 + i * 0.01));
ok(was(o).length === 1 && !/LIMIT/.test(JSON.stringify(o)), 'no daily reply limit for teachers (12 questions)');
// stuck: 3 h → one reminder, 6 h → the team (+ push)
o = tick(L, at(3.6));
ok(/आठवण/.test(txt(o)) && /Step 5/.test(txt(o)), '3 h on a step → one reminder', txt(o));
o = tick(L, at(6.7));
ok(L.tdemo.stuck && L.crm === 'call' && o.some(x => x.to === 'do' && x.action === 'team_push' && /अडकले/.test(x.data.title)), '6 h → stuck: Call desk + push', JSON.stringify(o.map(x => x.to + ':' + (x.tag || x.action || ''))));
// the team did it on a call → next step
o = W.teacherTeamStep(L, at(7));
ok(L.tdemo.step === 5 && /Step 6\/7/.test(txt(o)) && !L.tdemo.stuck, 'team "step done" → Step 6');
o = W.inbound(L, 'ts:done', at(7.1));
t = txt(o);
ok(L.tdemo.step === 6 && /Step 7\/7/.test(t) && /खास सूट/.test(t) && /8390484545/.test(t) && !/\d+\s*%/.test(t) && btns(o).includes('ts:call'), 'Step 7: खास सूट + call 8390484545, no percent', t);
o = W.inbound(L, 'ts:call', at(7.2));
ok(L.crm === 'call' && o.some(x => x.to === 'do' && x.action === 'team_push'), '📞 → Call desk + push');
// demo student ends: 12 h before → message; order → the end
L.lastInboundAt = at(59).toISOString();
o = tick(L, at(60.2));
ok(/बंद होईल/.test(txt(o)) && /JIP0001/.test(txt(o)), '12 h before the demo student closes → a reminder', txt(o));
o = W.event(L, 'tdemo', { order: 4990, added: 10 }, at(61));
ok(L.tdemo.doneAt && /अभिनंदन/.test(txt(o)) && o.some(x => x.to === 'do' && x.action === 'team_push' && /विद्यार्थी जोडले/.test(x.data.title)), 'order → 🎉 the end + push');

// 2) a teacher ad: straight in; words "मी शिक्षक आहे" from a parent's ad
let A = W.createLead({ gid: 'AAAA000002', courses: COURSES }, T0); A.mobile = '9822000002';
o = W.teacherWelcome(A, 'नमस्कार 🙏 मी शिक्षक आहे', T0);
ok(A.tdemo && A.tdemo.stage === 'cls' && btns(o).includes('tcls:1'), 'teacher ad → the teacher flow at once');
let P = W.createLead({ gid: 'AAAA000003', cls: COURSES[0], courses: COURSES }, T0); P.mobile = '9822000003'; P.lastInboundAt = T0.toISOString();
o = W.inbound(P, 'Sir mi teacher ahe, majhe classes ahet', at(0.1));
ok(P.tdemo && P.tdemo.stage === 'cls', '"mi teacher ahe" → the teacher flow');
let Q = W.createLead({ gid: 'AAAA000004', cls: COURSES[0], courses: COURSES }, T0); Q.lastInboundAt = T0.toISOString();
W.inbound(Q, 'माझ्या मुलाचा class 8वी आहे', at(0.1));
ok(!Q.tdemo, 'a parent\'s "class" words stay a parent');
// 3) an existing teacher: no new code, steps go on
let E = W.createLead({ gid: 'AAAA000005', courses: COURSES }, T0); E.mobile = '9822000005';
W.inbound(E, 'teacher', T0); W.inbound(E, 'tcls:0', at(0.01)); W.inbound(E, 'राणे सर, कागल', at(0.02));
o = W.event(E, 'tdemo', { account: { exists: true, tCode: 'RAN555', sCode: 'KAG0005' } }, at(0.03));
ok(/आधीच आहे/.test(txt(o)) && /RAN555/.test(txt(o)) && /Step 1\/7/.test(txt(o)), 'known teacher: "account आधीच आहे" + the steps', txt(o));
o = W.event(E, 'tdemo', { account: { exists: true, tCode: 'RAN555' } }, at(0.04));
ok(!was(o).length, 'a retried job after the codes: nothing twice');
// 4) Render could not make it
let X = W.createLead({ gid: 'AAAA000006', courses: COURSES }, T0); X.mobile = '9822000006';
W.inbound(X, 'teacher', T0); W.inbound(X, 'tcls:0', at(0.01)); W.inbound(X, 'Kale Sir, Sangli', at(0.02));
o = W.event(X, 'tdemo', { accountError: 'Demo सध्या बंद आहे' }, at(0.03));
ok(X.crm === 'call' && /Demo सध्या बंद/.test(txt(o)), 'account error → told + the team calls');
// 5) a /book-demo teacher (codes first, no stage) writes: codes + Step 1
let B = W.createLead({ gid: 'AAAA000007' }, T0); B.mobile = '9822000007';
B.tdemo = { tCode: 'BOO111', tPin: '1357', sCode: 'BOO0007', sPin: '2468', bookedAt: T0.toISOString() };
o = W.inbound(B, 'DEMO AAAA000007', at(0.1));
ok(/BOO111/.test(txt(o)) && /Step 1\/7/.test(txt(o)) && B.tdemo.stage === 'steps', '/book-demo teacher: codes + Step 1 on the first message');
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
