/* ════════════════════════════════════════════════════════════════════
   waFlow.js — the parent's WhatsApp journey as one pure rule engine.
   No DOM, no network, no clock: every call gets the lead (a plain object)
   and `now` (a Date) and returns what to send. The same file runs in the
   demo page (window.WA_FLOW) and on the server (require('./waFlow')), where
   a webhook calls inbound(), app/payment events call event(), and a timer
   calls tick() for leads whose nextDue() has come.

   Output items:
     { to: 'wa',   kind, cost, text, buttons: [{id, label}] }   WhatsApp
     { to: 'push', text, buttons }                               app notification
     { to: 'app',  text, buttons }                               a banner inside the app
     { to: 'log',  tag, text }                                   what happened behind (Admin log)
   A button's id is what comes back to inbound() when it is tapped.
   ════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WA_FLOW = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── settings: change here, not in the rules ──
  const CONFIG = {
    offerHours: 24, offerPercent: 50,
    offer2Percent: 30,            // after the 24 h: this much until the first Sunday 11 pm (IST), then the full price
    windowHours: 24,              // the free window after the parent's own message
    ctwaHours: 72,                // a click-to-WhatsApp ad: the bot may write free this long after the parent's first message
    earlyHours: 1,                // the daily test goes this much before the window closes, if the chosen time is later
    quiet: { from: 21, to: 8 },   // no message from the bot in these hours (IST)
    maxUnanswered: 4,             // bot's own messages in one window without a reply
    autoTemplates: false,         // false = the bot never pays for a message by itself: closed window → nothing,
                                  // the lead goes to the call list; only Admin sends a paid (template) message by hand
    missLimit: 2,                 // (only with autoTemplates) closed-window days without a reply → stop
    revisit: { month: 6, day: 1 },// a closed lead comes back in Admin on this date of the next year (June 1: new school year)
    reportEvery: 5,               // a short report + pay link after every N free tests
    waMaxTests: 2,                // free tests sent on WhatsApp; after these: "the app (all free tests) or the course" (owner, 2026-11-08)
    hotAfterDays: 7,              // still taking tests but not paid after N days → hot call list
    dailyTimes: [{ id: '18', label: 'संध्याकाळी 6', h: 18 }, { id: '19', label: '7', h: 19 }, { id: '20', label: '8', h: 20 }],
    mahaTest: { dow: 0, h: 10, m: 0, remindH: 8, resultH: 12 },
    prices: { service: 0, utility: 0.115, marketing: 0.86 },   // ₹, India (estimates — Meta changes them)
    site: 'https://nkseduorbit.in',
    play: 'https://play.google.com/store/apps/details?id=com.nkseduorbit.student',
    botNumber: '91XXXXXXXXXX',    // the WhatsApp Cloud API (bot) number — set when it exists
    teamNumber: '91YYYYYYYYYY',   // the team's own WhatsApp (calls + hand-sent messages, free)
    prizes: [[5, 'Compass box'], [8, 'Stationery kit'], [15, 'School bag']],
    demo: false,                  // true only in the demo page: the महा-Test result comes from the timeline, not from the server
  };

  // ── links ──
  const L = {
    result: g => `${CONFIG.site}/parent-pay.html?g=${g}`,   // the child's result (and the offer while unpaid)
    mt: cls => `${CONFIG.site}/maha-test.html?class=${encodeURIComponent(cls || '')}`,
    child: g => `${CONFIG.site}/student-app/?free=1&g=${g}`,
    pay: g => `${CONFIG.site}/parent-pay.html?g=${g}`,
    share: g => `${CONFIG.site}/student-app/?free=1&ref=${g}`,
    rules: g => `${CONFIG.site}/refer.html?ref=${g}`,
    bot: text => `https://wa.me/${CONFIG.botNumber}?text=${encodeURIComponent(text)}`,   // opens the bot's chat with the text ready
  };

  // ── time (IST, whatever the machine's zone) ──
  const H = 3600e3, IST = 5.5 * H;
  const ist = d => new Date(d.getTime() + IST);
  const hourOf = d => { const x = ist(d); return x.getUTCHours() + x.getUTCMinutes() / 60; };
  const dayKey = d => ist(d).toISOString().slice(0, 10);
  const dow = d => ist(d).getUTCDay();
  const atIST = (d, h, m = 0, addDays = 0) => { const x = ist(d); x.setUTCDate(x.getUTCDate() + addDays); x.setUTCHours(h, m, 0, 0); return new Date(x.getTime() - IST); };
  const quiet = d => { const h = hourOf(d); return h >= CONFIG.quiet.from || h < CONFIG.quiet.to; };
  const DAYS = ['रविवार', 'सोमवार', 'मंगळवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
  function whenText(d, now) {
    const k = dayKey(d);
    const day = k === dayKey(now) ? 'आज' : k === dayKey(new Date(now.getTime() + 24 * H)) ? 'उद्या' : DAYS[dow(d)] + 'ी';
    const h = hourOf(d), x = ist(d), mm = x.getUTCMinutes();
    const part = h < 12 ? 'सकाळी' : h < 17 ? 'दुपारी' : h < 21 ? 'संध्याकाळी' : 'रात्री';
    return `${day} ${part} ${x.getUTCHours() % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
  }
  // the class's next महा-Test: the server's real schedule (lead.mtNext) when it has one, else CONFIG's weekly slot
  function nextMahaTest(now, lead) {
    if (lead && lead.mtNext) { const d = new Date(lead.mtNext); return d > now ? d : null; }
    const mt = CONFIG.mahaTest;
    for (let i = 0; i < 8; i++) { const d = atIST(now, mt.h, mt.m, i); if (dow(d) === mt.dow && d > now) return d; }
    return null;
  }
  const isMtDay = (d, lead) => lead && lead.mtNext ? dayKey(new Date(lead.mtNext)) === dayKey(d) : dow(d) === CONFIG.mahaTest.dow;
  function mtLeft(now, lead) {
    const d = nextMahaTest(now, lead); if (!d) return '';
    const days = Math.round((Date.parse(dayKey(d)) - Date.parse(dayKey(now))) / (24 * H));
    return days === 0 ? `🏆 ${whenText(d, now)} ला महा-Test` : `🏆 महा-Test ला ${days} दिवस (${whenText(d, now)})`;
  }
  // "Monthly ₹200 → ₹100 · Yearly ₹1,500 → ₹750" from the class's real prices (lead.prices), nothing when unknown
  const rs = n => '₹' + Number(n).toLocaleString('en-IN');
  // the offer right now: { pct, end } (50 % for 24 h, then 30 % until the first Sunday 11 pm), or null
  function offerNow(lead, now) {
    if (lead.paid || !lead.offerEnd) return null;
    const e1 = new Date(lead.offerEnd);
    if (now < e1) return { pct: CONFIG.offerPercent, end: e1, stage: 1 };
    let d = atIST(e1, 23, 0, 0);
    for (let i = 0; i < 9 && (dow(d) !== 0 || d <= e1); i++) d = atIST(e1, 23, 0, i + 1);
    return now < d ? { pct: CONFIG.offer2Percent, end: d, stage: 2 } : null;
  }
  function priceText(lead, withOffer, now) {
    const o = withOffer ? offerNow(lead, now || new Date()) : null;
    if (withOffer && !o) withOffer = false;
    const p = lead.prices || {}, cut = n => Math.round(n * (100 - (o ? o.pct : 0)) / 100);
    const one = (label, n) => n ? `${label} ${rs(n)}${withOffer ? ' → ' + rs(cut(n)) : ''}` : '';
    return [one('Monthly', p.monthly), one('Yearly', p.yearly)].filter(Boolean).join(' · ');
  }

  // ── a new lead (one child of one family) ──
  function createLead(o, now) {
    return {
      gid: o.gid, name: o.name || 'तुमचा पाल्य', cls: o.cls || '', freeTotal: o.freeTotal || 0, totalTests: o.totalTests || 0, kind: o.kind || '', freeLessons: o.freeLessons || 0, lessonsSent: 0, courses: o.courses || [],
      source: o.source || '', createdAt: now.toISOString(),
      via: null,                    // 'wa' | 'form' | 'app'
      firstTestAt: null, offerEnd: null, testsDone: 0, last: null,
      lastInboundAt: null, unanswered: 0, sent: {},
      waCount: 0, cost: 0,
      daily: null,                  // a dailyTimes id, or 'no'
      testDay: null, miss: 0, stopped: false, closed: null,
      paid: false, app: false, pushOn: false, mtReg: false, shared: false,
      crm: null,                    // null | 'hot' | 'cold' | 'call' | 'paid' | 'closed'
      awaiting: null,
      acct: null,                   // the free account made when the number came: { code, pin } (pin '' = their own)
      waTests: 0, appAsked: null,   // test links sent on WhatsApp; the day "app or course" was sent
      ctwaUntil: null,              // came from a click-to-WhatsApp ad: the free window lasts till then (72 h)
    };
  }

  // ── sending ──
  // the free window: 24 h after the parent's last message, or (from a click-to-WhatsApp ad) 72 h after the first one
  const windowEnd = lead => Math.max(lead.lastInboundAt ? Date.parse(lead.lastInboundAt) + CONFIG.windowHours * H : 0, lead.ctwaUntil ? Date.parse(lead.ctwaUntil) : 0);
  const isOpen = (lead, now) => !!lead.lastInboundAt && now.getTime() < windowEnd(lead);
  const log = (tag, text) => ({ to: 'log', tag, text });
  // own = the bot starts it (counts toward maxUnanswered); a reply to the parent's message does not
  function wa(lead, now, text, buttons, opt = {}) {
    const open = isOpen(lead, now);
    if (lead.closed === 'STOP') return log('STOP', 'पालकाने STOP केलं → WhatsApp नाही.');
    if (opt.own && lead.closed) return log('CLOSED', 'Lead closed → bot स्वतःहून WhatsApp पाठवत नाही.');
    if (opt.own && open && lead.unanswered >= CONFIG.maxUnanswered) return log('LIMIT', `या खिडकीत ${CONFIG.maxUnanswered} मेसेज गेले, reply नाही → पाठवला नाही.`);
    if (!open && !opt.template) return log('CLOSED', 'खिडकी बंद: साधा मेसेज जाऊ शकत नाही (template हवा).');
    if (!open && !opt.manual && !CONFIG.autoTemplates) return log('₹ नाही', 'खिडकी बंद → bot स्वतः पैसे देऊन मेसेज पाठवत नाही (फक्त Admin हाताने).');
    const kind = open ? 'service' : opt.template;
    const cost = CONFIG.prices[kind] || 0;
    if (opt.own) lead.unanswered++;
    lead.waCount++; lead.cost = Math.round((lead.cost + cost) * 1000) / 1000;
    return { to: 'wa', kind, cost, text: grammar(text), buttons: buttons || [] };
  }
  const push = (text, buttons) => ({ to: 'push', text: grammar(text), buttons: buttons || [] });
  // the placeholder name in a sentence: "तुमचा पाल्य ची" → "तुमच्या पाल्याची"
  const GRAM = { 'ची': 'ची', 'चा': 'चा', 'चे': 'चे', 'चं': 'चं', 'ने': 'ने', 'साठी': 'साठी', 'ला': 'ला', 'च्या': 'च्या' };
  const grammar = text => String(text).replace(/तुमचा पाल्य (च्या|ची|चा|चे|चं|ने|साठी|ला)(?![\p{L}\p{M}])/gu, (_, x) => 'तुमच्या पाल्या' + GRAM[x]);
  // a message the team sends by hand from its own WhatsApp (not the bot number): free; Admin opens wa.me with this text
  // the team's number shown to parents ("📞 प्रश्न: 83904 84545"); '' while CONFIG.teamNumber is the placeholder
  const teamNo = () => (/^91[6-9]\d{9}$/.test(CONFIG.teamNumber) ? CONFIG.teamNumber.slice(2) : '');
  const teamLine = () => (teamNo() ? `\n📞 प्रश्न / call: ${teamNo()}` : '');
  // a parent's own question → the team (Admin › CRM / NKs Team "❓ प्रश्न"); the bot answers that it went
  function askTeam(lead, now, out, text, direct) {
    lead.question = { text: String(text).slice(0, 300), at: now.toISOString() };
    out.push(log('Q', `❓ पालकांचा प्रश्न: "${lead.question.text}" → team च्या "❓ प्रश्न" यादीत.`));
    out.push(wa(lead, now, `${direct ? '✅ प्रश्न आमच्या team कडे पाठवला' : '🙏 तुमचा प्रश्न आमच्या team कडे पाठवला आहे'} — उत्तर इथेच येईल.${teamNo() ? `\nलगेच बोलायचं असेल तर 📞 call / WhatsApp: ${teamNo()}` : ''}`,
      [{ id: 'TEST', label: '📝 Free test' }, { id: 'fee', label: '💳 फी' }, { id: 'call_me', label: '📞 Call हवा' }]));
  }
  const team = (lead, text) => ({ to: 'team', cost: 0, text, waMe: `https://wa.me/91${lead.mobile || ''}?text=${encodeURIComponent(text)}` });
  const appMsg = (text, buttons) => ({ to: 'app', text, buttons: buttons || [] });
  const canPush = lead => lead.app && lead.pushOn;

  // ── texts ──
  const HINT = '\n👉 पुढची free test हवी तेव्हा फक्त *TEST* पाठवा.';
  const freeWhat = lead => lead.kind === 'regular' ? 'free धडे' : 'free tests';
  // the free account: "Code ABC123 · PIN 4821" (PIN '' = the one they chose themselves)
  const acctLine = lead => lead.acct && lead.acct.code ? `👤 Code: *${lead.acct.code}* · 🔑 PIN: *${lead.acct.pin || 'तुमचाच'}*` : '';
  const appText = lead => lead.app ? '' : lead.acct && lead.acct.code
    ? `\n\n📲 ${lead.name} चं app account तयार — सगळ्या ${freeWhat(lead)} app मध्ये:\n${acctLine(lead)}\nApp 👇 Code + PIN टाका\n${CONFIG.play}`
    : `\n\nहवं असल्यास app install करा आणि सर्व उपलब्ध ${freeWhat(lead)} ${lead.kind === 'regular' ? 'पाहा' : 'सोडवा'} 👇\n${CONFIG.play}`;
  const tail = lead => (lead.kind === 'regular' ? '\n👉 पुढचा free धडा हवा तेव्हा फक्त *TEST* पाठवा.' : HINT) + appText(lead);
  // after CONFIG.waMaxTests links on WhatsApp: the rest of the free part is in the app, or the whole course
  function appOrCourse(lead, now, out, own) {
    lead.appAsked = dayKey(now);
    out.push(wa(lead, now, `✅ WhatsApp वरच्या ${CONFIG.waMaxTests} free ${lead.kind === 'regular' ? 'धडे' : 'tests'} झाल्या.\nपुढे दोन पर्याय:\n\n1️⃣ 📲 *App मध्ये* सगळ्या उरलेल्या ${freeWhat(lead)} — रोज आठवण पण app मधून${lead.acct && lead.acct.code ? '\n' + acctLine(lead) : ''}\n${CONFIG.play}\n\n2️⃣ 🔓 *पूर्ण course* उघडा${unlockText(lead, now)}`,
      lead.paid ? [] : [{ id: 'app', label: '📲 App' }, { id: 'pay', label: '💳 Course उघडा' }, { id: 'call_me', label: '📞 Call हवा' }], { own }));
    out.push(log('APP', `WhatsApp वर ${CONFIG.waMaxTests} tests झाल्या → app (Code + PIN) किंवा course. पुढच्या tests WhatsApp वर नाहीत.`));
  }
  const offerLine = (lead, now) => { const o = offerNow(lead, now); return o ? `\n🎁 पहिल्या payment वर ${o.pct}% सूट — ${whenText(o.end, now)} पर्यंत.` : ''; };
  const scoreLine = s => s ? `${s.score}/${s.total}${s.rank ? ` · ${s.of} विद्यार्थ्यांमध्ये #${s.rank}` : ''}${s.title ? `\n📝 ${s.title}` : ''}${s.weak ? `\nकमकुवत भाग: ${s.weak}` : ''}` : '';
  function mainButtons(lead, now) {
    const b = [];
    const o = offerNow(lead, now);
    if (o) b.push({ id: 'pay', label: `💳 ${o.pct}% सूट — pay` });
    if (!lead.mtReg) b.push({ id: 'mt_reg', label: '🏆 महा-Test नोंदणी' });
    if (!lead.app) b.push({ id: 'app', label: '📲 App' });
    b.push({ id: 'ask', label: '❓ प्रश्न' });
    return b;
  }

  // 🔓 the child's own course: what it opens, the price (with the offer while it runs) and the pay link — numbers from Admin
  function unlockText(lead, now) {
    if (lead.paid) return '';
    const o = offerNow(lead, now), on = !!o;
    const price = priceText(lead, on, now);
    const what = lead.kind === 'regular'
      ? `✅ सगळ्या विषयांचे सगळे धडे${lead.freeLessons ? ` (आत्ता ${lead.freeLessons} free)` : ''}: Notes · स्वाध्याय उत्तरं · सराव\n✅ Internet नसतानाही app मध्ये · पालकांना progress report`
      : `✅ सगळे ${lead.totalTests ? lead.totalTests + ' ' : ''}tests${lead.freeTotal ? ` (आत्ता ${lead.freeTotal} free)` : ''} · प्रत्येक प्रश्नाचं स्पष्टीकरण\n✅ Notes, Exercise आणि सराव · दर रविवारी महा-Test · पालकांना progress report`;
    return `\n\n🔓 *${lead.cls || 'पूर्ण'} course* — ${lead.name} साठी:\n` + what +
      (price ? `\n💳 ${price}${on ? ` (${o.pct}% सूट ${whenText(o.end, now)} पर्यंत)` : ''}` : '') +
      `\n👉 ${L.pay(lead.gid)}`;
  }
  const unlockButtons = lead => lead.paid ? [{ id: 'ask', label: '❓ प्रश्न' }]
    : [{ id: 'pay', label: '💳 Unlock करा' }, { id: 'ask', label: '❓ प्रश्न' }, { id: 'call_me', label: '📞 Call हवा' }];

  // the first WhatsApp answer: full result, offer, share line, then "daily test?"
  function firstAnswer(lead, now, out) {
    lead.courseAsked = true;
    const o = offerNow(lead, now), price = priceText(lead, !!o, now);
    out.push(wa(lead, now, `🎯 ${lead.name} चा result: ${scoreLine(lead.last)}` + (lead.paid ? `\n👇 ${L.result(lead.gid)}` :
      `\n\n🔓 पूर्ण ${lead.cls || ''} course — सगळे ${lead.totalTests ? lead.totalTests + ' ' : ''}tests, स्पष्टीकरण, notes, महा-Test${price ? `\n💳 ${price}` : ''}${o ? `\n🎁 ${o.pct}% सूट ${whenText(o.end, now)} पर्यंत` : ''}\n👇 पूर्ण result आणि course: ${L.pay(lead.gid)}`),
      unlockButtons(lead), { template: 'utility' }));
    // the app: where the rest of the free tests, the daily test and the offer's reminders are (data: app → 3 of 8 paid, no app → 0 of 23)
    if (!lead.app && !lead.paid) appPitch(lead, now, out, false);
  }
  // 📲 the app, on its own (short): the rest of the free tests there, with the Code + PIN
  function appPitch(lead, now, out, own) {
    const left = lead.freeTotal ? Math.max(0, lead.freeTotal - (lead.testsDone || 0)) : 0;
    lead.appPitchAt = now.toISOString();
    out.push(wa(lead, now, `📲 ${lead.name} च्या ${left ? 'उरलेल्या ' + left + ' ' : ''}free tests *app मध्ये* — रोजची test, गुण आणि सूटची आठवण app मधूनच.` +
      (lead.acct && lead.acct.code ? `\n${acctLine(lead)}\nApp 👇 Login → Code + PIN` : '\nInstall केल्यावर login लागत नाही 👇') + `\n${CONFIG.play}`,
      [{ id: 'pay', label: '💳 Course घ्या' }, { id: 'ask', label: '❓ प्रश्न' }], { own, template: 'utility' }));
  }
  // one free test link (at most one a day on WhatsApp; Sunday is the महा-Test's day)
  function testLink(lead, now, out, own) {
    if (!lead.cls && !lead.paid) {
      // the class is not known yet (a new number that skipped the class list): ask it, never "0 free tests done"
      if ((lead.courses || []).length) { lead.awaiting = 'cls'; out.push(wa(lead, now, '📝 कोणत्या class ची free test? 👇', clsButtons(lead), { own })); }
      else out.push(wa(lead, now, `📝 Free test (10 मिनिटं, login नाही) — class निवडा 👇\n${CONFIG.site}/student-app/?free=1`, [], { own }));
      return;
    }
    if (lead.paid) { out.push(wa(lead, now, `✅ ${lead.name} चे सगळे tests app मध्ये उघडे आहेत 👇\n${CONFIG.play}`, [], { own })); return; }
    if (lead.kind === 'regular' ? lead.freeLessons && lead.lessonsSent >= lead.freeLessons : lead.testsDone >= lead.freeTotal) {
      out.push(wa(lead, now, lead.kind === 'regular' ? `🎉 ${lead.name} चे सगळे ${lead.freeLessons} free धडे झाले! पुढचे धडे 👇\n${L.pay(lead.gid)}` : `🎉 ${lead.name} चे सगळे ${lead.freeTotal} free tests पूर्ण! पुढचे chapters 👇\n${L.pay(lead.gid)}`, [], { own })); return;
    }
    if (isMtDay(now, lead)) { out.push(wa(lead, now, `🏆 आज महा-Test चा दिवस. ${lead.mtReg ? `${lead.name} ने ${whenText(nextMahaTest(now, lead) || now, now)} ला याच link वरून द्यायचा 👇\n${L.child(lead.gid)}` : 'नोंदणी करायची?'}\nउद्यापासून पुन्हा रोजची free test.`, lead.mtReg ? [] : [{ id: 'mt_reg', label: '🏆 नोंदणी' }], { own })); return; }
    if (lead.testDay === dayKey(now)) {
      const t = CONFIG.dailyTimes.find(x => x.id === lead.daily);
      out.push(wa(lead, now, `✅ ${lead.name} ची आजची free test झाली आहे.\nउद्या ${t ? 'संध्याकाळी ' + (t.h - 12) + ' वाजता' : 'सकाळी'} नवीन test पाठवतो.\n\nहवं असल्यास app install करा आणि सर्व उपलब्ध free tests सोडवा 👇\n${CONFIG.play}`, lead.app ? [] : [{ id: 'app', label: '📲 App install' }], { own }));
      out.push(log('LIMIT', 'WhatsApp वर दिवसाला 1 free test → आजची आधीच दिली.'));
      return;
    }
    if (!lead.paid && (lead.waTests || 0) >= CONFIG.waMaxTests) { appOrCourse(lead, now, out, own); return; }
    lead.testDay = dayKey(now);
    lead.waTests = (lead.waTests || 0) + 1;
    if (lead.kind === 'regular') {
      lead.lessonsSent = (lead.lessonsSent || 0) + 1;
      const bl = [{ id: 'got', label: '👍 पाल्याला दिला' }];
      out.push(wa(lead, now, `📚 ${lead.name} चा आजचा free धडा${lead.freeLessons ? ` (${Math.min(lead.lessonsSent + 1, lead.freeLessons)}/${lead.freeLessons})` : ''} 👇\n📒 Notes · ✍️ स्वाध्याय उत्तरं · 📝 सराव\n${L.child(lead.gid)}` + tail(lead), bl, { own }));
      return;
    }
    const n = lead.testsDone + 1;
    const b = [{ id: 'got', label: '👍 पाल्याला दिली' }];
    if (!lead.mtReg) b.push({ id: 'mt_reg', label: '🏆 महा-Test नोंदणी' });
    out.push(wa(lead, now, `📝 ${lead.name} ची आजची free test (${n}/${lead.freeTotal}) 👇\n${L.child(lead.gid)}\n${mtLeft(now, lead)}` + tail(lead), b, { own }));
  }
  // the parent alone: first a note, then the child's own message — clean to forward as it is
  function childLinkMsgs(lead, now, out) {
    out.push(wa(lead, now, `👇 खालचा मेसेज ${lead.name} ला *forward* करा (मेसेज दाबून ठेवा → ↪️ Forward).\nTest दिली की result इथेच येईल.`));
    out.push(wa(lead, now, `${lead.name}, तुझी free test (10 मिनिटं, login नाही) 📝\n👇\n${L.child(lead.gid)}` +
      (lead.acct && lead.acct.code ? `\n\n📲 App मध्ये सगळ्या ${freeWhat(lead)}: ${acctLine(lead)}\n${CONFIG.play}` : '')));
  }
  function shareMsg(lead, now, out) {
    lead.shared = true;
    const prizes = CONFIG.prizes.map(p => `${p[0]} मित्र = ${p[1]}`).join(' · ');
    out.push(wa(lead, now, `🎓 NKs EduOrbit वरचे courses:\n${lead.courses.join(' · ')}\n\n📲 ओळखीच्या विद्यार्थ्यांना ही link पाठवा 👇\n${L.share(lead.gid)}\n\n🎁 तुमच्या link वरून आलेल्या मित्रांनी pay केलं ${lead.paid ? 'की' : 'आणि तुम्ही pay केलं की'} ते ${lead.name} च्या Refer & Earn मध्ये मोजले जातात: ${prizes}.\nनियम 👉 ${L.rules(lead.gid)}` + HINT,
      [{ id: 'share_done', label: '📲 Share केलं' }, { id: 'rules', label: '📄 नियम पाहा' }]));
    out.push(log('SHARE', 'Courses + share link: दुसऱ्या test नंतर, पालकांच्या reply ला उत्तर म्हणून (मोफत). यादी Admin मधल्या classes मधून.'));
  }
  function offerMsg(lead, now, out) {
    if (!lead.paid) lead.payWantAt = now.toISOString();   // 💳 asked for the course here: a warm family for the team
    if (lead.paid) { out.push(wa(lead, now, `✅ ${lead.name} चं account आधीच चालू आहे.`)); return; }
    const o = offerNow(lead, now);
    out.push(wa(lead, now, `${o ? `🎁 पहिल्या payment वर ${o.pct}% सूट — ${whenText(o.end, now)} पर्यंत.${priceText(lead, true, now) ? '\n' + priceText(lead, true, now) : ''}` : '📚 सगळे chapters, tests, notes आणि महा-Test' + (priceText(lead, false, now) ? '\n💳 ' + priceText(lead, false, now) : '') + (lead.testsDone ? '' : '\n🎁 Free test दिली की 50% सूट (24 तास).')}\n👇 ${L.pay(lead.gid)}`,
      [{ id: 'ask', label: '❓ प्रश्न' }, { id: 'call_me', label: '📞 Call हवा' }]));
  }
  function answer(lead, now, out, text) {
    out.push(wa(lead, now, text, [{ id: 'ok', label: '✅ समाधान झालं' }, { id: 'more', label: '❌ अजून मदत हवी' }]));
  }

  // the महा-Test result (the server sends it as an event; the demo from its timeline)
  function mtResult(lead, now, out, s) {
    lead.mtLast = { score: s.score, total: s.total, rank: s.rank || null, of: s.of || null, at: now.toISOString() };
    out.push(log('MT', `${lead.name} ने महा-Test दिला → ${s.score}/${s.total}.`));
    if (canPush(lead)) out.push(push(`🏆 महा-Test: ${s.score}/${s.total}${s.rank ? ` · #${s.rank} / ${s.of}` : ''}`, lead.paid ? [] : [{ id: 'push:REPORT', label: '📊 WhatsApp वर रिपोर्ट' }]));
    else if (!lead.closed && lead.lastInboundAt) out.push(wa(lead, now, `🏆 ${lead.name} चा महा-Test result\n${scoreLine(s)}\nTop 10 👇 ${L.mt(lead.cls)}` + unlockText(lead, now), lead.paid ? [{ id: 'got', label: '👍' }] : unlockButtons(lead), { template: 'utility' }));
    if (!lead.paid && !lead.closed && !lead.stopped && lead.testsDone >= 3 && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', '🔥 रोज tests देतो + महा-Test, pay नाही → गरम call यादी (result नंतर call).')); }
  }

  // ── a family that wrote first from a number the bot does not know (a click-to-WhatsApp ad, or "hi") ──
  // the number is the lead; the class (from the ad, else asked), then the child's name → the child's link + Code + PIN
  // a button's own id coming back is never a name
  const BUTTON_IDS = ['fee', 'keep', 'call_me', 'got', 'mt_reg', 'mt_want', 'ask', 'ok', 'more', 'next', 'app', 'pay', 'share_done', 'rules'];
  const clsButtons = lead => (lead.courses || []).slice(0, 10).map((c, i) => ({ id: 'cls:' + i, label: c }));
  function askName(lead, now, out, hello) {
    lead.awaiting = 'name';
    out.push(wa(lead, now, `${hello ? 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\n' : ''}${lead.cls ? lead.cls + ' ची ' : ''}free test (10 मिनिटं, login नाही) 📝\nResult, क्रमांक आणि कुठे सराव हवा ते इथेच पाठवतो.\n\n✍️ पाल्याचं (मुलाचं / मुलीचं) नाव लिहा 👇`));
  }
  // owner (2026-11-12): a parent from a class's ad is not asked again — the class's test link goes at once (to forward
  // or open here); the child types the name on the website, and the free account (Code + PIN) follows from there
  function linkFirst(lead, now, out, hello) {
    lead.awaiting = null;
    out.push(wa(lead, now, `${hello ? 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\n' : ''}👇 खालचा मेसेज पाल्याला *forward* करा, किंवा याच phone वर उघडा.\nTest दिली की result आणि क्रमांक इथेच येईल.${hello ? teamLine() : ''}`));
    out.push(wa(lead, now, `${lead.cls} ची free test 📝 (10 मिनिटं, login नाही)\n👇\n${L.child(lead.gid)}`));
    if (lead.ctwaUntil && !lead.mtReg && lead.mtNext && new Date(lead.mtNext) > now)
      out.push(wa(lead, now, `🏆 ${whenText(new Date(lead.mtNext), now)} ला ${lead.cls} चा महा-Test — सगळ्यांमध्ये क्रमांक कळेल. नोंदणी करू? (मोफत)`, [{ id: 'mt_reg', label: '🏆 हो, नोंदणी करा' }]));
    out.push(log('CRM', `Class माहीत (${lead.cls}) → test ची link लगेच, काही विचारलं नाही. नाव मूल website वर लिहील; मग app account (Code + PIN) इथे.`));
  }
  function welcome(lead, raw, now) {
    const out = [];
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; lead.via = 'wa'; lead.welcomed = true;
    out.push(log('CRM', lead.ctwaUntil ? `💬 WhatsApp ad मधून पहिला message → नंबर आपोआप, lead. ${CONFIG.ctwaHours} तास bot मोफत लिहू शकतो.` : 'नवीन नंबरवरून पहिला message → lead. 24 तास bot मोफत लिहू शकतो.'));
    if (!lead.cls && (lead.courses || []).length) {
      lead.awaiting = 'cls';
      out.push(wa(lead, now, 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\nपाल्याची free test (10 मिनिटं, login नाही) 📝\nकोणत्या class साठी?', clsButtons(lead)));
      return out;
    }
    if (lead.cls) linkFirst(lead, now, out, true);
    else { askName(lead, now, out, true); return out; }   // nothing known about the class and no list (Render asleep): the name first
    // the first message was an icebreaker / command (fee, call, महा-Test): answer that too
    const first = alias(String(raw || ''));
    if (['fee', 'call_me', 'mt_reg'].includes(first)) out.push(...inbound(lead, first, now).filter(x => !(first === 'mt_reg' && x.to === 'wa' && /नोंदणी करू/.test(x.text || ''))));
    return out;
  }

  // ── the parent's message (or a button tap) ──
  // WhatsApp Manager › Automations: the icebreakers (ready questions in a new chat) and the "/" commands come in as
  // plain text — the same as the bot's own keywords / buttons
  function alias(t) {
    const x = t.trim().toLowerCase();
    if (x === '/test' || /free test द्यायची/.test(x)) return 'TEST';
    if (x === '/fee' || /फी किती/.test(x)) return 'fee';
    if (x === '/mahatest' || /महा-test नोंदणी/.test(x)) return 'mt_reg';
    if (x === '/call' || /मला call करा/.test(x)) return 'call_me';
    return t;
  }
  // free text (not a button / keyword) → what the parent means; '' = not sure (the usual handling)
  function meaning(t, lead) {
    const x = t.trim().toLowerCase().replace(/[?!.,🙏]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!x || x.length > 60) return /can i get more info/.test(x) ? 'hello' : '';
    if (/(^|\s)(fee|fees|फी|फीस|फिस|किंमत|price|charges?|rate)(\s|$)|kiti\s*(fee|fees|paise|rupaye|charge)|किती\s*(पैसे|रुपये|फी)|पैसे किती/.test(x)) return 'fee';
    if (/admission|प्रवेश|join|(कोर्स|course)\s*(घ्यायच|हवा|घेणार|buy)|^(कोर्स|course)$|buy|खरेदी|subscribe|enroll/.test(x)) return 'pay';
    if (/can i get more info|more info on this|माहिती हवी|माहिती द्या|info pathva|details/.test(x)) return 'hello';
    if (/^(thank you|thanks|thank u|thanku|thx|धन्यवाद|ok|okay|ओके|ठीक आहे|thik ahe|👍|🙏)( (sir|madam|मॅडम|सर|ji|जी))?$/.test(x)) return 'ok';
    if (/^(nmms|test|टेस्ट|link|लिंक|परीक्षा|exam|free test|फ्री टेस्ट)( (link|पाठवा|द्या|pathva|dya|please|pls))?$/.test(x)) return 'TEST';
    if (/^(hi+|hello+|hey|hlo|हाय|हॅलो|नमस्कार|namaskar|namaste|नमस्ते|good morning|सुप्रभात)( (sir|madam|मॅडम|सर|ji|जी))?$/.test(x)) return 'hello';
    if (/^(हो|ho|yes|ha|haa|हा|हां|ho na|ok ho|हो चालेल|chalel|चालेल)$/.test(x)) return lead.courseAsked && lead.testsDone ? 'pay' : 'hello';
    return '';
  }
  function inbound(lead, raw, now) {
    const out = [];
    const t = alias(String(raw || '').trim());
    const up = t.toUpperCase();
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; lead.miss = 0;
    if (lead.closed && lead.closed !== 'STOP' && up !== 'STOP') { out.push(log('CRM', `Closed lead (${lead.closed}) ने स्वतः मेसेज केला → पुन्हा उघडला, प्रवास पुन्हा सुरू.`)); lead.closed = null; lead.stopped = false; lead.crm = null; lead.revisitAt = null; }
    else if (lead.stopped && lead.closed !== 'STOP' && up !== 'STOP') { out.push(log('RESUME', 'Reply आला → call यादीतून बाहेर, रोजचा प्रवास पुन्हा सुरू.')); lead.stopped = false; if (lead.crm === 'cold' || lead.crm === 'form' || lead.crm === 'import') lead.crm = null; }
    if ((lead.crm === 'form' || lead.crm === 'import') && up !== 'STOP') { lead.crm = null; out.push(log('RESUME', 'Form ने नंबर दिलेल्या पालकांनी reply दिला → WhatsApp प्रवास सुरू.')); }
    if (up === 'STOP') { lead.closed = 'STOP'; lead.stopped = true; out.push({ to: 'wa', kind: 'service', cost: 0, text: '🙏 ठीक आहे, आता मेसेज बंद. पुन्हा हवं असेल तर START पाठवा.', buttons: [] }); return out; }
    if (up === 'START' && lead.closed === 'STOP') { lead.closed = null; lead.stopped = false; out.push(wa(lead, now, '🙏 परत स्वागत!', mainButtons(lead, now))); return out; }
    if (/^\[(reaction|sticker|unsupported|unknown)\]$/i.test(t)) return out;
    const kw = up.split(/\s+/)[0];
    if (lead.awaiting === 'question' && !/^[a-z_]+:/i.test(t) && !['TEST', 'STOP'].includes(kw) && !BUTTON_IDS.includes(t)) {
      lead.awaiting = null; askTeam(lead, now, out, t, true); return out;
    }
    if (lead.awaiting === 'cls') {
      const m = t.match(/^cls:(\d+)$/);
      const c = m ? (lead.courses || [])[Number(m[1])] : (lead.courses || []).find(x => x.toLowerCase() === t.toLowerCase());
      if (c) { lead.cls = c; out.push({ to: 'do', action: 'batch', data: { batch: c } }); out.push(log('CRM', `Class WhatsApp वर निवडला: ${c}.`)); linkFirst(lead, now, out, false); return out; }
      // a sentence (not a class): the parent's own question → the team; the class list stays for later
      if (t.length >= 8 && /\s/.test(t) && !BUTTON_IDS.includes(t)) { askTeam(lead, now, out, t, false); return out; }
      if (!/^[a-z_]+:/i.test(t) && !['TEST', 'STOP'].includes(kw)) { out.push(wa(lead, now, 'खालच्या यादीतून class निवडा 👇', clsButtons(lead))); return out; }
    }
    if (lead.awaiting === 'name' && !/^[A-Z_]+:/.test(up) && !['TEST', 'STOP'].includes(kw) && !BUTTON_IDS.includes(t)) {
      const given = t.replace(/^name:/i, '').replace(/[^\p{L}\p{M} .'-]/gu, '').trim().slice(0, 30);
      if (given.length < 2) { out.push(wa(lead, now, '✍️ फक्त पाल्याचं नाव लिहा (उदा. राहुल) 👇')); return out; }
      lead.awaiting = null; lead.name = given; out.push({ to: 'do', action: 'name', name: lead.name });
      childLinkMsgs(lead, now, out);
      // from an ad: the महा-Test registration now — its reminder can come inside the free 72 h
      if (lead.ctwaUntil && !lead.mtReg && lead.mtNext && new Date(lead.mtNext) > now)
        out.push(wa(lead, now, `🏆 ${whenText(new Date(lead.mtNext), now)} ला महा-Test — सगळ्या विद्यार्थ्यांमध्ये ${lead.name} चा क्रमांक कळेल. नोंदणी करू? (मोफत)`, [{ id: 'mt_reg', label: '🏆 हो, नोंदणी करा' }]));
      out.push(log('CRM', `पाल्याचं नाव ${lead.name}. Test ची वाट; दिली की result इथे.${lead.welcomed ? ' App account (Code + PIN) Render बनवतो आणि इथे येतो.' : ''}`));
      return out;
    }
    // a parent's short words (fees / NMMS / hi / हो / admission…): answered here, not "समजलं नाही"
    if (!BUTTON_IDS.includes(t) && !/^[a-z_]+:/i.test(t) && !/\b[0-9A-F]{10}\b/.test(t) && !['RESULT', 'VERIFY', 'LINK', 'TEST', 'PUSH', 'MAHA', 'MTWANT', 'HELP', 'OFFER', 'MAHATEST', 'REPORT', 'LOGIN', 'START'].includes(kw)) {
      const m = meaning(t, lead);
      if (m === 'hello') {
        if (!lead.testsDone && lead.cls && !lead.paid) out.push(wa(lead, now, `नमस्कार 🙏 ${lead.name} ची free test (10 मिनिटं, login नाही) 👇\n${L.child(lead.gid)}\nTest दिली की गुण आणि क्रमांक इथे येतील.`, mainButtons(lead, now)));
        else out.push(wa(lead, now, 'नमस्कार 🙏 काय मदत करू?', mainButtons(lead, now)));
        return out;
      }
      if (m === 'fee' || m === 'pay') { if (m === 'pay') lead.payWantAt = now.toISOString(); return inbound(lead, m === 'fee' ? 'fee' : 'pay', now); }
      if (m === 'TEST') return inbound(lead, 'TEST', now);
      if (m === 'ok') return inbound(lead, 'ok', now);
    }
    if (kw === 'RESULT' || kw === 'VERIFY') {
      const first = !lead.via; lead.via = lead.via || 'wa';
      if (first) { out.push({ to: 'do', action: 'lead' }); out.push(log('CRM', 'नंबर WhatsApp वरून आपोआप → lead. Meta ला "Lead".')); }
      if (kw === 'VERIFY') out.push(log('LOGIN', 'नंबर WhatsApp ने पक्का → OTP template नाही (₹0).'));
      firstAnswer(lead, now, out); return out;
    }
    if (kw === 'LINK') {
      const given = t.split(/\s+/).slice(2).join(' ').replace(/[^\p{L}\p{M} .'-]/gu, '').trim().slice(0, 30);
      if (!lead.via) out.push({ to: 'do', action: 'lead' }); lead.via = lead.via || 'wa';
      if (given.length >= 2) {
        lead.name = given; out.push({ to: 'do', action: 'name', name: given });
        childLinkMsgs(lead, now, out);
        out.push(log('CRM', `पालक एकटे: नाव website वरून (${given}), नंबर WhatsApp वरून. पाल्याची link forward साठी. Meta ला "Lead".`));
        return out;
      }
      lead.awaiting = 'name'; out.push(wa(lead, now, 'नमस्कार 🙏 पाल्याचं नाव काय?')); out.push(log('CRM', 'पालक एकटे: नंबर WhatsApp वरून आपोआप, form नाही. Meta ला "Lead".')); return out; }
    if (kw === 'TEST' && !lead.via && lead.kind === 'regular') {
      out.push({ to: 'do', action: 'lead' }); lead.via = 'wa'; lead.testDay = dayKey(now);   // today's lesson was on the website
      out.push(log('CRM', 'Website चं "पुढचा धडा" बटण → नंबर WhatsApp वरून आपोआप → lead. Meta ला "Lead".'));
      out.push(wa(lead, now, `✅ नमस्कार! ${lead.name} चा आजचा free धडा झाला.\nउद्यापासून रोज 1 free धडा (Notes + स्वाध्याय उत्तरं) इथे पाठवू.` + unlockText(lead, now), unlockButtons(lead), { template: 'utility' }));
      if (!lead.daily) out.push(wa(lead, now, '📚 रोज 1 free धडा कोणत्या वेळी पाठवू?', [...CONFIG.dailyTimes.map(x => ({ id: 'daily:' + x.id, label: x.label })), { id: 'daily:no', label: 'नको' }]));
      return out;
    }
    if (kw === 'TEST' && !lead.via && lead.testsDone >= 1) {
      // the first message, from the website's "next test" button: the number becomes the lead; result + daily time
      out.push({ to: 'do', action: 'lead' }); lead.via = 'wa';
      out.push(log('CRM', 'Website चं "पुढची test" बटण → नंबर WhatsApp वरून आपोआप → lead. Meta ला "Lead".'));
      firstAnswer(lead, now, out); return out;
    }
    if (kw === 'TEST' || t === 'टेस्ट' || t === 'पुढची' || kw === 'PUSH') {
      lead.stopped = false; testLink(lead, now, out, false);
      if (lead.kind === 'regular' && !lead.daily && !lead.paid && !lead.app && !(lead.acct && lead.acct.code)) out.push(wa(lead, now, lead.kind === 'regular' ? '📚 असा रोज 1 free धडा पाठवू? कोणत्या वेळी?' : '📝 अशी रोज 1 free test पाठवू? कोणत्या वेळी?', [...CONFIG.dailyTimes.map(x => ({ id: 'daily:' + x.id, label: x.label })), { id: 'daily:no', label: 'नको' }])); out.push(log(kw === 'PUSH' ? 'PUSH' : 'TEST', kw === 'PUSH' ? 'Push चं 💬 WhatsApp बटण → खिडकी 24 तास.' : 'पालकाने स्वतः TEST मागितलं → मोफत, खिडकी 24 तास.')); return out; }
    if (kw === 'MAHA' || kw === 'MTWANT' || t === 'mt_want') {
      // the window is open now (they wrote): the result and the rank come here as soon as the महा-Test closes
      if (!lead.via) { out.push({ to: 'do', action: 'lead' }); lead.via = 'wa'; }
      lead.mtWant = true;
      out.push(wa(lead, now, kw === 'MAHA'
        ? `🏆 ${lead.name} चा महा-Test जमा झाला ✅\nसगळ्यांचा test संपला की गुण, क्रमांक आणि Top 10 इथेच पाठवतो.`
        : `✅ ठीक आहे! महा-Test नंतर ${lead.name} चे गुण आणि क्रमांक इथेच येतील.`, lead.mtReg ? [{ id: 'got', label: '👍 ठीक' }] : [{ id: 'mt_reg', label: '🏆 नोंदणी करा' }]));
      out.push(log('MT', kw === 'MAHA' ? 'महा-Test नंतर website वरून WhatsApp → खिडकी उघडी, result इथे.' : kw === 'MTWANT' ? 'टीमच्या महा-Test आठवणीतली bot link → खिडकी 24 तास उघडी, result इथे.' : 'शनिवारी "result WhatsApp वर हवा? ✅" → खिडकी रविवारपर्यंत उघडी.'));
      return out;
    }
    if (kw === 'HELP') { out.push(wa(lead, now, 'नमस्कार 🙏 काय मदत हवी?', [{ id: 'ask:pin', label: 'PIN विसरलो' }, { id: 'ask:open', label: 'Test उघडत नाही' }, { id: 'ask:fee', label: 'फी किती?' }])); return out; }
    if (kw === 'OFFER' || t === 'pay') { offerMsg(lead, now, out); return out; }
    if (kw === 'MAHATEST' || t === 'mt_reg') {
      if (lead.mtReg) out.push(wa(lead, now, `✅ ${lead.name} ची नोंदणी आधीच झाली आहे. ${mtLeft(now, lead)}.`));
      else { lead.mtReg = true; out.push({ to: 'do', action: 'mt_register' }); out.push(wa(lead, now, `✅ ${lead.name} ची ${whenText(nextMahaTest(now, lead) || now, now)} च्या महा-Test साठी नोंदणी झाली.\nत्या वेळी याच link वरून test 👇\n${L.child(lead.gid)}\nTest संपताच गुण आणि क्रमांक इथे.`)); out.push(log('CRM', 'महा-Test नोंदणी (WeeklyEntry).')); }
      return out;
    }
    if (kw === 'REPORT') { out.push(wa(lead, now, `📊 ${lead.name}: ${lead.testsDone} tests${lead.last ? `, शेवटचा ${lead.last.score}/${lead.last.total}` : ''}.\nकमकुवत: ${lead.last?.weak || '—'}\nसगळे chapters 👇 ${L.pay(lead.gid)}` + HINT, [{ id: 'ask', label: '❓ प्रश्न' }])); return out; }
    if (kw === 'LOGIN') { out.push(wa(lead, now, '🔑 PIN विसरलात? App मध्ये ❓ मदत → "Student Code / PIN विसरलो" → "📲 WhatsApp ने" दाबा. तिथून आलेला message इथे Send केला की नवीन PIN ठेवता येतो.')); out.push(log('LOGIN', 'Login: app मधला one-time code (LOGIN <24 अक्षरं>) index.js मध्ये तपासला जातो; साधा LOGIN = मार्गदर्शन.')); return out; }
    if (t.startsWith('daily:')) {
      const id = t.slice(6), c = CONFIG.dailyTimes.find(x => x.id === id);
      lead.daily = c ? id : 'no';
      out.push(wa(lead, now, c ? `✅ रोज ${c.h - 12} वाजता ${lead.name} ची पुढची free test येईल. ${mtLeft(now, lead)}.\nमेसेज नको असतील तर कधीही STOP पाठवा.` : '🙏 ठीक आहे. महा-Test ची आठवण मात्र देऊ.\nमेसेज नको असतील तर कधीही STOP पाठवा.'));
      out.push(log('CRM', c ? `रोजची free test: ${c.h - 12} वाजता (रविवारी महा-Test).` : 'रोजची test नको → फक्त महा-Test.'));
      return out;
    }
    if (t === 'app') { out.push(wa(lead, now, lead.acct && lead.acct.code ? `हे घ्या 👇\n${CONFIG.play}\nApp उघडा → Login → ${acctLine(lead)}\nसगळ्या ${freeWhat(lead)} तिथे आहेत आणि रोजची आठवण app मधून येईल.` : `हे घ्या 👇\n${CONFIG.play}\nInstall केल्यावर login लागत नाही. ${lead.name} चे गुण app मध्ये आपोआप दिसतील.`)); return out; }
    if (t === 'keep') { out.push(wa(lead, now, `👍 ठीक आहे! ${lead.name} चे result, पुढची free test आणि महा-Test ची आठवण इथेच येईल. कधीही *TEST* पाठवा.`)); out.push(log('CTWA', 'पालकांनी "आठवण हवी" दाबलं → खिडकी पुन्हा 24 तास.')); return out; }
    if (t === 'got') { out.push(wa(lead, now, '👍 Test झाली की result इथे येईल.')); return out; }
    if (t === 'next') { out.push(wa(lead, now, '👍 उद्या पुढची पाठवतो.')); if (!lead.shared && lead.testsDone >= 2) shareMsg(lead, now, out); return out; }
    if (t === 'ask') { out.push(wa(lead, now, 'कोणता प्रश्न?', [{ id: 'ask:fee', label: 'फी किती?' }, { id: 'ask:app', label: 'App कसा वापरायचा?' }, { id: 'ask:other', label: '💬 दुसरा प्रश्न' }])); return out; }
    if (t === 'ask:other') { lead.awaiting = 'question'; out.push(wa(lead, now, '✍️ तुमचा प्रश्न लिहा 👇')); return out; }
    if (t === 'fee') { out.push(wa(lead, now, `💳 ${priceText(lead, true, now) || 'फी pay page वर'}${offerLine(lead, now)}${offerNow(lead, now) || lead.testsDone ? '' : '\n🎁 Free test दिली की 50% सूट (24 तास).'}\nसगळे tests, notes आणि महा-Test 👇\n${L.pay(lead.gid)}`, [{ id: 'pay', label: '💳 Course घ्या' }, { id: 'call_me', label: '📞 Call हवा' }])); return out; }
    if (t === 'ask:fee') { answer(lead, now, out, `${priceText(lead, false, now) || 'फी: pay page वर'}.${offerLine(lead, now)}\nPay नंतर सगळे tests, notes, स्वाध्याय उत्तरं आणि महा-Test.`); return out; }
    if (t === 'ask:app') { answer(lead, now, out, lead.acct && lead.acct.code ? `Play Store वरून install करा → Login → ${acctLine(lead)} → Home वर "पुढचा test". PIN विसरलात तर Login वर "📲 WhatsApp ने login".` : 'Play Store वरून install करा → login लागत नाही → Home वर "पुढचा test". Pay नंतर Student Code + PIN किंवा WhatsApp login.'); return out; }
    if (t === 'ask:pin') { answer(lead, now, out, 'App → Login → "📲 WhatsApp ने login" → नवीन PIN. 1 मिनिट.'); return out; }
    if (t === 'ask:open') { answer(lead, now, out, 'App update करा (Play Store) आणि internet चालू ठेवून एकदा उघडा.'); return out; }
    if (t === 'ok') { out.push(wa(lead, now, 'धन्यवाद 🙏', mainButtons(lead, now))); return out; }
    if (t === 'more' || t === 'call_me') { lead.crm = 'call'; lead.callAt = now.toISOString(); out.push(wa(lead, now, '🙏 धन्यवाद! आमची team तुम्हाला लवकरच call करेल.')); out.push(log('CALL', '📞 Call request → Admin › CRM "Call करायचे" (वरती) + लाल संख्या.')); return out; }
    if (t === 'share_done') { out.push(wa(lead, now, '🙏 धन्यवाद! मित्रांनी pay केलं की तुमच्या Refer & Earn मध्ये दिसेल 👉 ' + L.rules(lead.gid))); out.push(log('SHARE', `मित्र आला की "कोणाकडून" नोंद (ref=${lead.gid}). Free असताना मित्र राखून ठेवले जातात; pay केल्यावर मोजले जातात.`)); return out; }
    if (t === 'rules') { out.push(wa(lead, now, `📄 ${L.rules(lead.gid)}\nमित्राने pay केलं तरच मोजला जातो · pay नंतर 7 दिवसांनी पक्का · तुम्ही free असताना आलेले मित्र तुम्ही pay केल्यावर मोजले जातात · तुमच्याच नंबरवरून नाही · बक्षिसासाठी पालकांची संमती + पत्ता.`)); return out; }
    if (/^q:[A-D]$/.test(t)) { const okA = t === 'q:B'; out.push(wa(lead, now, (okA ? '✅ बरोबर! फरक 4, 6, 8, 10 → 30.' : 'थोडं चुकलं 🙂 फरक 4, 6, 8 → पुढचा 10 → 30 (B).') + offerLine(lead, now), mainButtons(lead, now))); return out; }
    // a parent's own words the bot cannot answer: a question for the team (not a stray button id / one letter)
    if (t.length >= 3 && !/^[a-z_]+(:[\w-]+)?$/i.test(t)) { askTeam(lead, now, out, t, false); return out; }
    out.push(wa(lead, now, 'माफ करा, समजलं नाही 🙏 खालचं बटण दाबा किंवा TEST पाठवा.', mainButtons(lead, now)));
    return out;
  }

  // ── what happened elsewhere (website, app, payment, Admin) ──
  function event(lead, type, data, now) {
    const out = [];
    data = data || {};
    if (type === 'test_done') {
      // data.n = the server's own count of this child's tests (the event may arrive after a sync that already counted it)
      const first = !lead.firstTestAt || data.n === 1;
      lead.testsDone = data.n || lead.testsDone + 1; lead.last = data;
      lead.testDay = dayKey(now);   // one free test a day, wherever it was taken (website or WhatsApp link)
      if (first) {
        if (!lead.firstTestAt) lead.firstTestAt = now.toISOString();
        if (!lead.offerEnd) lead.offerEnd = new Date(new Date(lead.firstTestAt).getTime() + CONFIG.offerHours * H).toISOString();
        out.push(log('OFFER', `पहिली test → ${CONFIG.offerPercent}% सूट ${CONFIG.offerHours} तास (test संपल्यापासून).`));
        if (lead.via === 'wa' && lead.lastInboundAt) firstAnswer(lead, now, out);   // the parent-alone path: the child's first test
        return out;
      }
      const report = lead.testsDone % CONFIG.reportEvery === 0;
      const done = lead.testsDone >= lead.freeTotal;
      if (canPush(lead)) {
        out.push(push(`${lead.name}: ${data.score}/${data.total} ✅${report ? ' · 📊 रिपोर्ट तयार' : ''}`, report && !lead.paid ? [{ id: 'push:REPORT', label: '📊 WhatsApp वर रिपोर्ट' }] : []));
      } else {
        const b = lead.paid ? [{ id: 'next', label: '✅ उद्याची पाठवा' }, { id: 'ask', label: '❓ प्रश्न' }] : [{ id: 'next', label: '✅ उद्याची पाठवा' }, { id: 'pay', label: '💳 Unlock करा' }, { id: 'ask', label: '❓ प्रश्न' }];
        out.push(wa(lead, now, `✅ ${lead.name} ने आजची test दिली: ${scoreLine(data)}\n👇 result: ${L.result(lead.gid)}` +
          (report && !lead.paid ? `\n\n📊 रिपोर्ट: ${lead.testsDone} tests, कमकुवत: ${data.weak || '—'}.\nसगळे chapters 👇 ${L.pay(lead.gid)}` : '') +
          (done && !lead.paid ? `\n\n🎉 सगळे ${lead.freeTotal} free tests पूर्ण!` : '') + unlockText(lead, now) +
          (!lead.app && !lead.paid && !done ? `\n\n📲 पुढच्या tests app मध्ये${lead.acct && lead.acct.code ? ' · ' + acctLine(lead) : ''}\n${CONFIG.play}` : ''), b, { template: 'utility' }));   // real activity: not counted in maxUnanswered
      }
      if (report) out.push(log('REPORT', `दर ${CONFIG.reportEvery} tests नंतर रिपोर्ट + pay link (रोज offer नाही).`));
      if (done && !lead.paid && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', '🔥 सगळे free tests पूर्ण, pay नाही → गरम call यादी.')); }
      return out;
    }
    if (type === 'sync') {
      // fresh facts from the server (name, class, free tests, courses, prices, next महा-Test, paid, app…); no message
      const hadAcct = !!(lead.acct && lead.acct.code);
      for (const k of ['name', 'cls', 'freeTotal', 'totalTests', 'kind', 'freeLessons', 'courses', 'prices', 'mtNext', 'mtReg', 'paid', 'app', 'pushOn', 'mobile', 'testsDone', 'acct']) if (data[k] !== undefined && data[k] !== null && !((k === 'cls' || k === 'name') && !data[k])) lead[k] = data[k];
      // a family that started on WhatsApp: the free account comes after the name — one message with it
      if (!hadAcct && lead.acct && lead.acct.code && lead.acct.pin && lead.welcomed && !lead.awaiting && !lead.app && !lead.paid && isOpen(lead, now))
        out.push(wa(lead, now, `📲 ${lead.name} चं app account पण तयार — सगळ्या ${freeWhat(lead)} app मध्ये, रोजची आठवण app मधून:\n${acctLine(lead)}\nApp 👇 Login → Code आणि PIN टाका\n${CONFIG.play}`));
      if (data.firstTestAt && !lead.firstTestAt) { lead.firstTestAt = data.firstTestAt; lead.offerEnd = data.offerEnd || new Date(new Date(data.firstTestAt).getTime() + CONFIG.offerHours * H).toISOString(); }
      if (data.last) lead.last = data.last;
      if (lead.paid && lead.crm !== 'paid') lead.crm = 'paid';
      return out;
    }
    if (type === 'mt_result') { mtResult(lead, now, out, data); return out; }
    // 💳 the parent opened the pay page (Render: parent-pay.html) or pressed Pay there without finishing: the team
    // calls them first (Admin › CRM / NKs Team "☀️ आधी call", on top). Nothing is sent to the parent.
    if (type === 'pay_seen') {
      if (lead.paid) return out;
      const last = lead.paySeenAt ? Date.parse(lead.paySeenAt) : 0;
      lead.paySeenAt = now.toISOString(); lead.paySeenN = (lead.paySeenN || 0) + 1;
      if (data.checkout) { lead.checkoutAt = now.toISOString(); out.push(log('PAY', '💳 Pay पानावर "Pay" दाबलं पण पूर्ण झालं नाही → "☀️ आधी call" मध्ये सगळ्यात वर. लगेच call करा.')); }
      else if (now.getTime() - last > 30 * 60e3) out.push(log('PAY', '💳 पालकांनी pay पान उघडलं → "☀️ आधी call" मध्ये सगळ्यात वर.'));
      return out;
    }
    if (type === 'form_number') {
      // typed the number on the website (no WhatsApp message from them): the bot sends nothing (it would cost);
      // the lead waits in the call list, where Admin can call or send one WhatsApp by hand.
      // Admin's "➕ नवीन पालक" / "📤 Import" come here too (data.manual / data.import): the 📥 list, with a label.
      if (data.labelId) lead.labels = [...new Set([...(lead.labels || []), data.labelId])];
      if (data.place && !lead.place) lead.place = data.place;
      if (data.note) out.push(log('NOTE', data.note));
      const added = !!(data.import || data.manual);
      // an old number brought in (backfill / a list import) is not a "🆕 new" family for the team
      // (only a family the bot did not know yet — one already talking here / on the website stays as it is)
      const known = !!(lead.via || lead.lastInboundAt);
      if (data.backfill && !known) lead.backfilled = true;
      if (data.import && !known) lead.imported = true;
      if ((lead.via && lead.via !== 'form') || lead.lastInboundAt) return out;   // already talking on WhatsApp / in the app
      if ((data.backfill || added) && lead.via === 'form') return out;     // already in the CRM: nothing new
      lead.via = 'form';
      if (added) {
        if (!lead.crm) lead.crm = 'import';
        out.push(log('IMPORT', `${data.import ? '📤 Import' : data.by ? '➕ ' + data.by + ' ने हाताने' : '➕ Admin ने हाताने'}${data.label ? ' (' + data.label + ')' : ''} → 📥 यादी. Bot काही पाठवत नाही: call करा किंवा टीमच्या WhatsApp वरून message.`));
        return out;
      }
      if (!lead.crm || lead.crm === 'form') lead.crm = 'form';
      out.push(log('FORM', data.backfill ? 'जुना lead (website वरचा नंबर) CRM मध्ये आणला → call यादी. Bot काही पाठवत नाही.' : 'Form वरून नंबर (संमतीची खूण). खिडकी उघडी नाही → bot काही पाठवत नाही. 📞 call यादी: call करा किंवा Admin मधून हाताने WhatsApp.'));
      return out;
    }
    if (type === 'app_installed') {
      lead.app = true; lead.via = lead.via || 'app';
      out.push(appMsg('🔔 Notifications allow करा — पुढच्या test ची आणि महा-Test ची वेळ कळेल.', [{ id: 'push:on', label: 'Allow' }, { id: 'push:off', label: "Don't allow" }]));
      out.push(log('APP', 'App install (install referrer → तोच guest, गुण तसेच).'));
      return out;
    }
    if (type === 'push') {
      lead.pushOn = !!data.on;
      if (lead.pushOn) out.push(log('PUSH', 'Notifications चालू → रोजची test push ने (मोफत). Pay नसलेल्यांच्या push मध्ये 💬 WhatsApp बटण.'));
      else {
        out.push(appMsg('🔔 Notifications बंद आहेत — पुढच्या test ची वेळ कळणार नाही.', [{ id: 'push:settings', label: '⚙️ Settings उघडा' }]));
        out.push(log('PUSH', 'Notifications बंद → रोजची test WhatsApp वरच चालू. App मध्ये "⚙️ Settings उघडा" banner (Android: app notification settings).'));
      }
      return out;
    }
    if (type === 'paid') {
      lead.paid = true; lead.crm = 'paid';
      out.push(wa(lead, now, `🎉 ${lead.name} चं account तयार!\n👤 Student Code: ${data.code || '—'}\n🔑 PIN: ${lead.acct && lead.acct.code === data.code && lead.acct.pin ? '*' + lead.acct.pin + '*' : 'तुम्ही ठेवलेला'}\n📱 App 👇 ${CONFIG.play}\nकिंवा "📲 WhatsApp ने login" — code टाइप करावा लागत नाही.${teamLine()}`, [], { template: 'utility' }));
      out.push(log('PAY', 'Payment → account active. सूट आणि pay चे मेसेज बंद; पुढे push फक्त app मध्ये.'));
      return out;
    }
    if (type === 'call') {
      if (data.result === 'will_pay') { out.push(team(lead, `नमस्कार 🙏 बोलल्याप्रमाणे ${lead.name} साठी pay link 👇\n${L.pay(lead.gid)}\n\nप्रश्न / पुढची free test: आमच्या bot ला इथे message करा 👇\n${L.bot('TEST')}`)); out.push(log('CALL', 'Call: pay करणार → टीमच्या WhatsApp वरून pay link + bot link (मोफत).')); }
      if (data.result === 'later') { lead.crm = 'later'; out.push(log('CALL', `Call: नंतर → ${data.at || 'तारीख'} ला पुन्हा call यादीत.`)); }
      if (data.result === 'not_interested') {
        const x = ist(now); let y = x.getUTCFullYear(); if (x.getUTCMonth() + 1 >= CONFIG.revisit.month) y++;
        lead.revisitAt = new Date(Date.UTC(y, CONFIG.revisit.month - 1, CONFIG.revisit.day, 4, 30)).toISOString();   // 10 am IST
        lead.closed = data.reason || 'इतर'; lead.stopped = true; lead.crm = 'closed';
        out.push(log('CRM', `❌ Call करून confirm → Closed (${lead.closed}). Bot चे सगळे WhatsApp बंद. ${canPush(lead) ? 'App: फक्त नेहमीचे push.' : 'App नाही → काहीच नाही.'} नंबर जतन: 📅 ${CONFIG.revisit.day}/${CONFIG.revisit.month}/${y} ला Admin मध्ये "पुढचं वर्ष" यादीत. स्वतः मेसेज केला / pay केलं तर लगेच पुन्हा उघडतो.`));
      }
      return out;
    }
    if (type === 'manual_wa') {
      // Admin › CRM: by default from the TEAM's own WhatsApp (another number, free) with the bot's chat link,
      // so the parent's reply opens the bot's free window; data.via === 'bot' = a paid template from the bot number
      if (data.via === 'bot') {
        out.push(wa(lead, now, data.text || `नमस्कार 🙏 ${lead.name} साठी NKs EduOrbit कडून — पुढची free test हवी असेल तर फक्त *TEST* पाठवा.`, [{ id: 'TEST', label: '📝 हो, TEST' }], { template: 'marketing', manual: true }));
        out.push(log('MANUAL', 'Bot नंबरवरून template (marketing ₹' + CONFIG.prices.marketing + '). फक्त गरज असेल तेव्हाच.'));
      } else {
        out.push(team(lead, data.text || `नमस्कार 🙏 मी NKs EduOrbit च्या टीममधून.\n${lead.name} साठी पुढची free test हवी असेल तर खालची link दाबा आणि Send करा 👇\n${L.bot('TEST')}\n${mtLeft(now, lead)}`));
        out.push(log('MANUAL', 'टीमच्या WhatsApp वरून (वेगळा नंबर, मोफत) + bot ची chat link. पालकांनी link दाबून Send केलं की bot ची मोफत खिडकी उघडते आणि प्रवास पुन्हा सुरू.'));
      }
      return out;
    }
    return out;
  }

  // ── the bot's own schedule ──
  // every item: { key, at, run(out) }; tick() runs the due ones once, nextDue() tells when to call again
  function plan(lead) {
    const items = [];
    if (lead.closed === 'STOP') return items;
    if (!lead.firstTestAt) { if (lead.ctwaUntil) ctwaItems(lead, items); return items; }
    const first = new Date(lead.firstTestAt), offerEnd = new Date(lead.offerEnd);
    const hasWa = !!lead.lastInboundAt;
    // 1) pay nudges inside the offer (never as paid templates)
    const nudge = (key, at, fn) => { if (!lead.paid && !quiet(at) && at < offerEnd) items.push({ key, at, run: fn }); };
    nudge('nudge1', new Date(first.getTime() + H), (out, now) => {
      if (lead.lastInboundAt && now - new Date(lead.lastInboundAt) < 0.8 * H) return;   // just talked
      // no app yet: the next test is waiting there (the app is where families pay: 3 of 8 vs 0 of 23)
      if (!lead.app && isOpen(lead, now)) { out.push(wa(lead, now, `📲 ${lead.name} ची पुढची free test app मध्ये तयार आहे — 1 मिनिटात install.${lead.acct && lead.acct.code ? '\n' + acctLine(lead) : ''}\n👇 ${CONFIG.play}`, [{ id: 'pay', label: '💳 Course घ्या' }, { id: 'ask', label: '❓ प्रश्न' }], { own: true })); return; }
      if (isOpen(lead, now)) out.push(wa(lead, now, lead.last?.weak ? `${lead.name} चा कमकुवत भाग: ${lead.last.weak} 📐\nPaid मध्ये या भागाचे सराव tests आणि प्रत्येक प्रश्नाची युक्ती.` : `📚 ${lead.name} साठी paid मध्ये: सगळ्या chapters चे सराव tests, प्रत्येक प्रश्नाची युक्ती, notes आणि महा-Test.`, [{ id: 'pay', label: 'हो, दाखवा' }], { own: true }));
      else if (canPush(lead)) out.push(push(lead.last?.weak ? `${lead.name} चा कमकुवत भाग: ${lead.last.weak} — सराव पाहा` : `${lead.name} साठी सगळ्या chapters चा सराव — पाहा`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
    });
    nudge('nudge2', atIST(first, 8, 0, 1), (out, now) => {
      if (isOpen(lead, now)) out.push(wa(lead, now, `🌅 सुप्रभात! ${lead.name} साठी आजचा प्रश्न 👇\nमालिका: 2, 6, 12, 20, ?\nA) 28  B) 30  C) 32  D) 36` + offerLine(lead, now), ['A', 'B', 'C', 'D'].map(x => ({ id: 'q:' + x, label: x })), { own: true }));
      else if (canPush(lead)) out.push(push(`🌅 आजचा प्रश्न — 1 मिनिट${offerLine(lead, now).replace('\n', ' · ')}`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
    });
    nudge('nudge3', new Date(offerEnd.getTime() - 3 * H), (out, now) => {
      const o2 = offerNow(lead, new Date(offerEnd.getTime() + 60e3));
      if (isOpen(lead, now)) out.push(wa(lead, now, `⏳ ${CONFIG.offerPercent}% सूट 3 तासांत संपेल${priceText(lead, true, now) ? ' (' + priceText(lead, true, now) + ')' : ''}.${o2 ? `\nत्यानंतर ${whenText(o2.end, now)} पर्यंत ${o2.pct}%.` : ''}\n👇 ${L.pay(lead.gid)}\nकाही शंका असेल तर आमची team call करू शकते.`, [{ id: 'call_me', label: '📞 Call हवा' }], { own: true }));
      else if (canPush(lead)) out.push(push(`⏳ ${CONFIG.offerPercent}% सूट 3 तासांत संपेल`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
    });
    // 📲 the next evening, still no app: once more (before the daily test)
    const appEve = atIST(first, 18, 30, 1);
    if (!lead.paid && !isMtDay(appEve, lead)) items.push({ key: 'appeve', at: appEve, run: (out, now) => {
      if (lead.app || lead.paid || lead.closed || lead.stopped || !isOpen(lead, now)) return;
      if (lead.appPitchAt && now - new Date(lead.appPitchAt) < 20 * H) return;
      appPitch(lead, now, out, true);
    } });
    // 2) the daily free test, from the day after the first test, not on Sunday
    const choice = CONFIG.dailyTimes.find(x => x.id === lead.daily);
    if ((choice || canPush(lead)) && !lead.paid) {
      for (let d = 1; d <= 21; d++) {
        const base = atIST(first, choice ? choice.h : 19, 0, d);
        if (isMtDay(base, lead)) continue;
        let at = base;
        // the window would close before the chosen time: go a little before it closes
        if (!canPush(lead) && lead.lastInboundAt) {
          const early = new Date(windowEnd(lead) - CONFIG.earlyHours * H);
          if (early < base && dayKey(early) === dayKey(base) && !quiet(early)) at = early;   // the same day, from 8 am
        }
        items.push({ key: 'daily:' + dayKey(base), at, run: (out, now) => {
          if (lead.kind === 'regular' ? lead.freeLessons && lead.lessonsSent >= lead.freeLessons : lead.testsDone >= lead.freeTotal) return;
          if (lead.closed) { if (canPush(lead)) out.push(push('आजची free test तयार 📝')); return; }
          if (lead.testDay === dayKey(now)) return;
          if (canPush(lead)) { out.push(push(`${lead.name}, आजची free test (${lead.testsDone + 1}/${lead.freeTotal}) · ${mtLeft(now, lead)}`, [{ id: 'app:open', label: '📱 App उघडा' }, { id: 'push:PUSH', label: '💬 WhatsApp वर link' }])); return; }
          if (lead.stopped || !hasWa) return;
          if (!lead.paid && (lead.waTests || 0) >= CONFIG.waMaxTests && lead.appAsked) return;   // asked once: app or course
          if (isOpen(lead, now)) { testLink(lead, now, out, true); return; }
          if (!CONFIG.autoTemplates) {
            // no reply, window closed: no paid message — stop and put the family on the call list
            lead.stopped = true; if (!lead.crm || lead.crm === 'hot') lead.crm = 'cold';
            out.push(log('COLD', 'खिडकी बंद, reply नाही → bot थांबला (पैसे नाहीत). ❄️ call यादी: call करून confirm → close, किंवा Admin मधून हाताने WhatsApp. Reply आला की पुन्हा सुरू.'));
            return;
          }
          lead.miss++;
          if (lead.miss < CONFIG.missLimit) { out.push(wa(lead, now, `📝 ${lead.name} ची आजची free test तयार आहे. पाठवू?` + tail(lead), [{ id: 'TEST', label: 'हो, पाठवा' }], { own: true, template: 'utility' })); out.push(log('MISS', 'Reply नाही → खिडकी बंद → एक utility template.')); }
          else { lead.stopped = true; if (!lead.crm) lead.crm = 'cold'; out.push(log('STOP', `${CONFIG.missLimit} वेळा reply नाही → रोजचे मेसेज बंद. ❄️ थंड call यादी.`)); }
        } });
      }
    }
    // 3) the महा-Test: a reminder 1.5 h before (the server's real slot, lead.mtNext; else CONFIG's weekly slot);
    //    the result comes from the server as an event (the demo makes one at noon)
    const slots = [];
    if (lead.mtNext) slots.push(new Date(lead.mtNext));
    else for (let w = 0; w < 3; w++) { const d = nextMahaTest(new Date(first.getTime() + w * 7 * 24 * H)); if (d) slots.push(d); }
    mtItems(lead, items, slots, hasWa);
    // 4) a week on, still free and still taking tests → hot list
    items.push({ key: 'hot', at: new Date(first.getTime() + CONFIG.hotAfterDays * 24 * H), run: (out) => {
      if (!lead.paid && !lead.closed && !lead.stopped && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', `🔥 ${CONFIG.hotAfterDays} दिवस, tests चालू, pay नाही → गरम call यादी.`)); }
    } });
    return items;
  }
  // a family from a click-to-WhatsApp ad that has not taken a test yet: inside the free 72 h, two gentle reminders
  // (the next two evenings), the महा-Test's own reminders if it falls inside, and one "keep the reminders?" near the end
  // owner (2026-11-12): within the 72 h every family is asked at least once to take the course — "give the test, get
  // 50 % off, take the course" (the offer starts with the first test: 50 % for 24 h, then 30 % until Sunday night)
  const testOfferLine = '🎁 Test दिली की course वर *50% सूट* (24 तास), मग रविवारपर्यंत 30%.';
  // short (owner: as little text as possible): one line of what the course is, the price, the link
  const shortCourse = (lead, now) => `🔓 ${lead.cls || 'पूर्ण'} course: सगळे tests + स्पष्टीकरण, notes, महा-Test${priceText(lead, false, now) ? '\n💳 ' + priceText(lead, false, now) : ''}\n👉 ${L.pay(lead.gid)}`;
  const courseButtons = [{ id: 'pay', label: '💳 Course घ्या' }, { id: 'call_me', label: '📞 Call हवा' }];
  function ctwaItems(lead, items) {
    const start = new Date(lead.createdAt), end = new Date(lead.ctwaUntil);
    const mtEve = lead.mtNext ? atIST(new Date(lead.mtNext), 20, 30, -1) : null;
    // the same day: 6:30 pm (children are home) — or 3 h later when they came in the evening
    const t3 = new Date(start.getTime() + 3 * H);
    const same = hourOf(start) < 15.5 ? atIST(start, 18, 30, 0) : (quiet(t3) ? null : t3);
    if (same && same > start && same < end) items.push({ key: 'ctwa:0', at: same, run: (out, now) => {
      if (lead.testsDone || lead.paid || lead.closed || lead.stopped || lead.awaiting || !lead.cls || !isOpen(lead, now)) return;
      out.push(wa(lead, now, `📝 ${lead.name} ची free test झाली का? मुलं घरी आली की फक्त 10 मिनिटं 👇\n${L.child(lead.gid)}\nTest दिली की गुण आणि क्रमांक इथे येतील.`,
        [{ id: 'got', label: '👍 पाल्याला दिली' }, { id: 'call_me', label: '📞 Call हवा' }], { own: true }));
    } });
    for (const d of [1, 2]) {
      const at = atIST(start, 19, 0, d);
      if ((mtEve && dayKey(mtEve) === dayKey(at)) || isMtDay(at, lead)) continue;   // that evening the महा-Test goes instead
      if (at < end) items.push({ key: 'ctwa:' + d, at, run: (out, now) => {
        if (lead.paid || lead.closed || lead.stopped || !isOpen(lead, now)) return;
        if (lead.testsDone) {
          // tested: the app if not there yet (once a day at most), else the offer while it runs
          if (!lead.app) { if (!lead.appPitchAt || now - new Date(lead.appPitchAt) > 20 * H) appPitch(lead, now, out, true); return; }
          const o = offerNow(lead, now);
          if (o) { lead.courseAsked = true; out.push(wa(lead, now, `⏳ ${lead.name} साठी ${o.pct}% सूट ${whenText(o.end, now)} पर्यंत${priceText(lead, true, now) ? ' (' + priceText(lead, true, now) + ')' : ''}.\nसगळे tests, notes आणि महा-Test 👇\n${L.pay(lead.gid)}`, [{ id: 'pay', label: '💳 Course घ्या' }, { id: 'call_me', label: '📞 Call हवा' }], { own: true })); }
          return;
        }
        if (lead.awaiting === 'cls') out.push(wa(lead, now, '🙏 पाल्याची free test अजून बाकी आहे. कोणत्या class साठी? 👇', clsButtons(lead), { own: true }));
        else if (lead.awaiting === 'name') out.push(wa(lead, now, `🙏 ${lead.cls ? lead.cls + ' ची ' : ''}free test अजून बाकी आहे (10 मिनिटं).\n${testOfferLine}\n✍️ पाल्याचं नाव लिहा — link लगेच पाठवतो 👇`, [], { own: true }));
        else (lead.courseAsked = true, out.push(wa(lead, now, `📝 ${lead.name === 'तुमचा पाल्य' ? 'पाल्याने' : lead.name + ' ने'} free test दिली का? फक्त 10 मिनिटं, login नाही 👇\n${L.child(lead.gid)}\n\n${testOfferLine}\n${shortCourse(lead, now)}`, [{ id: 'got', label: '👍 पाल्याला दिली' }, ...courseButtons], { own: true })));
      } });
    }
    let last = new Date(end.getTime() - 3 * H);
    if (quiet(last)) last = hourOf(last) < CONFIG.quiet.to ? atIST(last, 20, 30, -1) : atIST(last, 20, 30, 0);
    if (last > start) items.push({ key: 'ctwa:end', at: last, run: (out, now) => {
      if (lead.paid || lead.closed || !isOpen(lead, now)) return;
      // they wrote lately (the window goes on anyway) and the course was already offered: nothing more
      if (lead.courseAsked && lead.lastInboundAt && Date.parse(lead.lastInboundAt) + CONFIG.windowHours * H > end.getTime()) return;
      lead.courseAsked = true;
      const who = lead.name === 'तुमचा पाल्य' ? 'तुमच्या पाल्यासाठी' : lead.name + ' साठी';
      out.push(wa(lead, now, `🙏 ${who} course घ्यायचा आहे का?${lead.testsDone ? '' : '\n' + testOfferLine}\n👉 ${L.pay(lead.gid)}\n\nपुढच्या आठवणी हव्या असतील तर ✅ दाबा.${teamLine()}`, [{ id: 'keep', label: '✅ हो, आठवण हवी' }, ...courseButtons], { own: true }));
    } });
    if (lead.mtNext) mtItems(lead, items, [new Date(lead.mtNext)], true);
  }
  function mtItems(lead, items, slots, hasWa) {
    for (const sun of slots) {
      const k = dayKey(sun), at = new Date(sun.getTime() - 0.5 * H);
      // the evening before (8:30 pm): one tap keeps the window open through the महा-Test and its result
      const eve = atIST(sun, 20, 30, -1);
      if (!quiet(eve) && eve < sun) items.push({ key: 'mtask:' + k, at: eve, run: (out, now) => {
        if (lead.closed || lead.stopped || !hasWa || lead.paid && !lead.mtReg) return;
        const b = [{ id: 'mt_want', label: '✅ हो, पाठवा' }];
        if (!lead.mtReg) b.push({ id: 'mt_reg', label: '🏆 नोंदणी करा' });
        out.push(wa(lead, now, `🏆 उद्या ${whenText(sun, now).replace(/^उद्या\s*/, '')} ला महा-Test.\n${lead.name} चे गुण आणि क्रमांक test संपताच WhatsApp वर हवे?`, b, { own: true, template: 'utility' }));
      } });
      if (!quiet(at)) items.push({ key: 'mt:' + k, at, run: (out, now) => {
        const when = whenText(sun, now);
        if (canPush(lead)) { out.push(push(`🏆 ${when} ला महा-Test — ${lead.mtReg ? 'नोंदणी झाली आहे' : 'आत्ता नोंदणी करा'}`, lead.paid ? [] : [{ id: 'push:MAHATEST', label: '💬 WhatsApp वर' }])); return; }
        if (lead.closed || !hasWa) return;
        if (lead.mtReg) out.push(wa(lead, now, `🏆 ${when} ला महा-Test. ${lead.name} ने याच link वरून द्यायचा 👇\n${L.child(lead.gid)}`, [{ id: 'got', label: '👍 ठीक' }], { own: true, template: 'utility' }));
        else if (!lead.stopped) out.push(wa(lead, now, `🏆 ${when} ला महा-Test. ${lead.name} ची नोंदणी करा?`, [{ id: 'mt_reg', label: '🏆 नोंदणी करा' }], { own: true, template: 'utility' }));
      } });
      if (CONFIG.demo) items.push({ key: 'mtres:' + k, at: atIST(sun, CONFIG.mahaTest.resultH), run: (out, now) => {
        if (lead.mtReg) mtResult(lead, now, out, { score: 38, total: 50, rank: 57, of: 412, weak: 'आकृती, वेन आकृती' });   // demo numbers only
      } });
    }
  }
  function tick(lead, now) {
    const out = [];
    for (const it of plan(lead).sort((a, b) => a.at - b.at)) {
      if (it.at > now || lead.sent[it.key]) continue;
      lead.sent[it.key] = now.toISOString();
      if (now - it.at > 6 * H) continue;   // long past (server was down): skip, never send old reminders
      it.run(out, now);
    }
    return out;
  }
  // the earliest unsent item; one already due (but less than 6 h old) counts too, so a server that saves
  // "next due" after a message never skips it — the host just runs tick() at max(nextDue, now)
  function nextDue(lead, now) {
    let best = null;
    const oldest = new Date(now.getTime() - 6 * H);
    for (const it of plan(lead)) if (!lead.sent[it.key] && it.at > oldest && (!best || it.at < best)) best = it.at;
    return best;
  }

  return { CONFIG, L, createLead, inbound, welcome, event, tick, nextDue, isOpen, whenText, dayKey, atIST, priceText, offerNow };
});
