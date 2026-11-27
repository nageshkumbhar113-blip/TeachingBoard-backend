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
    offer2Percent: 30, offer2Hours: 48,   // after the 24 h: this much for 2 more days (owner 2026-11-16), then the full price
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
    waMaxTests: 1,
    dailyReplies: 8,              // answered messages a day from one family; then the team (owner 2026-11-14)                // free tests sent on WhatsApp; after these: "the app (all free tests) or the course" (owner, 2026-11-08)
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
    // Play Store with the child's code: the app (install referrer) continues the same child — tests and marks
    app: g => `${CONFIG.play}&referrer=${encodeURIComponent('guest=' + g + '&utm_source=whatsapp')}`,
  };
  // ── the Test Series (owner 2026-11-25: parents read "Test Series", never "class" / "course") ──
  // the name from the server (lead.series.name, Admin's "parents' name"), else made from the batch name
  const ORD = { 1: '1ली', 2: '2री', 3: '3री', 4: '4थी' };
  function cleanName(name) {
    let x = String(name || '').replace(/\b(batch|exam|class)\b/gi, ' ').replace(/\b\d{2,4}\s*[-–]\s*\d{2,4}\b/g, ' ');
    x = x.replace(/\b(\d{1,2})\s*(st|nd|rd|th)\b/gi, (_, n) => ORD[n] || n + 'वी');
    return x.replace(/\s*\(\s*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([-–])\s*$/, '').trim() || String(name || '').trim();
  }
  const SN = lead => (lead.series && lead.series.name) || cleanName(lead.cls);
  const TS = lead => (SN(lead) ? SN(lead) + ' Test Series' : 'Test Series');
  const isExam = lead => lead.kind !== 'regular';
  // link buttons (WhatsApp "cta_url": one per message, free inside the 24 h window) — meta.js bodiesFor sends them
  const payBtn = (lead, now, label) => { const o = !lead.paid && now ? offerNow(lead, now) : null; return { url: L.pay(lead.gid), label: label || (o ? `💳 ${o.pct}% सूट — Pay करा` : '💳 Pay करा') }; };
  const appBtn = lead => ({ url: lead.paid || (lead.acct && lead.acct.code) ? CONFIG.play : L.app(lead.gid), label: '📲 App Download' });
  const INFO = { id: 'info', label: 'ℹ️ पूर्ण माहिती' };
  const PAY_LINE = '👇 खालचं बटण दाबा आणि pay करा';
  const APP_LINE = '👇 खालचं बटण दाबा आणि app download करा';

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
  // the offer right now: { pct, end } (50 % for 24 h, then 30 % for 2 days; the team's own 🎁 30 / 50 % for 3 h first), or null
  function offerNow(lead, now) {
    if (lead.paid) return null;
    // the server keeps the offer (Admin may stop / change it): its promised steps, team first; [] = no offer
    if (lead.srvOffer && Array.isArray(lead.srvOffer.steps)) {
      const s = lead.srvOffer.steps.find(x => x && x.end && now < new Date(x.end));
      return s ? { pct: s.pct, end: new Date(s.end), stage: s.stage, name: lead.srvOffer.name || '' } : null;
    }
    const t = lead.teamOffer;
    if (t && t.end && now < new Date(t.end)) return { pct: t.pct, end: new Date(t.end), stage: 'team' };
    if (!lead.offerEnd) return null;
    const e1 = new Date(lead.offerEnd);
    if (now < e1) return { pct: CONFIG.offerPercent, end: e1, stage: 1 };
    const d = new Date(e1.getTime() + CONFIG.offer2Hours * H);
    return now < d ? { pct: CONFIG.offer2Percent, end: d, stage: 2 } : null;
  }
  // "🎁 Demo test सोडवली की Test Series वर 50% सूट (24 तास), मग 2 दिवस 30%." from Admin's settings; '' when the offer is off
  function ruleText(lead, { short = false, bold = true } = {}) {
    const c = lead.offerCfg || { on: true, name: '', p1: CONFIG.offerPercent, h1: CONFIG.offerHours, p2: CONFIG.offer2Percent, h2: CONFIG.offer2Hours };
    if (!c.on || !c.p1) return '';
    const hrs = h => h % 24 === 0 ? `${h / 24 === 1 ? '24 तास' : h / 24 + ' दिवस'}` : `${h} तास`;
    const pct = bold ? `*${c.p1}% सूट*` : `${c.p1}% सूट`;
    const head = c.name ? `${c.name}: ` : '';
    if (short) return `${head}Free test दिली की ${c.p1}% सूट (${hrs(c.h1)}).`;
    return `${head}Demo test सोडवली की Test Series वर ${pct} (${hrs(c.h1)})${c.p2 && c.h2 ? `, मग ${hrs(c.h2)} ${c.p2}%` : ''}.`;
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
    return { to: 'wa', kind, cost, text: grammar(text), buttons: (buttons || []).filter(Boolean).map(b => ({ ...b, label: noFree(b.label) })) };
  }
  const push = (text, buttons) => ({ to: 'push', text: grammar(text), buttons: buttons || [] });
  // the placeholder name in a sentence: "तुमचा पाल्य ची" → "तुमच्या पाल्याची"
  const GRAM = { 'ची': 'ची', 'चा': 'चा', 'चे': 'चे', 'चं': 'चं', 'ने': 'ने', 'साठी': 'साठी', 'ला': 'ला', 'च्या': 'च्या' };
  // owner 2026-11-14: the word "free" made parents expect everything free — on WhatsApp it is a demo test / सराव
  const noFree = t => String(t).replace(/\bfree tests\b/gi, 'सराव tests').replace(/\bfree test\b/gi, 'demo test').replace(/\bfree धडे/g, 'नमुना धडे').replace(/\bfree धडा/g, 'नमुना धडा').replace(/फ्री टेस्ट/g, 'demo test');
  const grammar = text => noFree(String(text)).replace(/तुमचा पाल्य (च्या|ची|चा|चे|चं|ने|साठी|ला)(?![\p{L}\p{M}])/gu, (_, x) => 'तुमच्या पाल्या' + GRAM[x]);
  // a message the team sends by hand from its own WhatsApp (not the bot number): free; Admin opens wa.me with this text
  // the team's number shown to parents ("📞 प्रश्न: 83904 84545"); '' while CONFIG.teamNumber is the placeholder
  const teamNo = () => (/^91[6-9]\d{9}$/.test(CONFIG.teamNumber) ? CONFIG.teamNumber.slice(2) : '');
  const teamLine = () => (teamNo() ? `\n📞 प्रश्न / call: ${teamNo()}` : '');
  // a parent's own question → the team (Admin › CRM / NKs Team "❓ प्रश्न"); the bot answers that it went
  // (both outputs carry .qa: the Worker may let the AI answer instead — index.js aiTry — and then drops them)
  function askTeam(lead, now, out, text, direct) {
    const prev = lead.question || null;
    lead.question = { text: String(text).slice(0, 300), at: now.toISOString() };
    const q = log('Q', `❓ पालकांचा प्रश्न: "${lead.question.text}" → team च्या "❓ प्रश्न" यादीत.`); q.qa = { text: lead.question.text, prev };
    const w = wa(lead, now, `${direct ? '✅ प्रश्न आमच्या team कडे पाठवला' : '🙏 तुमचा प्रश्न आमच्या team कडे पाठवला आहे'} — उत्तर इथेच येईल.${teamNo() ? `\nलगेच बोलायचं असेल तर 📞 call / WhatsApp: ${teamNo()}` : ''}`,
      [{ id: 'TEST', label: '📝 Free test' }, { id: 'fee', label: '💳 फी' }, { id: 'call_me', label: '📞 Call हवा' }]); w.qa = true;
    out.push(q, w);
  }
  const team = (lead, text) => ({ to: 'team', cost: 0, text, waMe: `https://wa.me/91${lead.mobile || ''}?text=${encodeURIComponent(text)}` });
  const appMsg = (text, buttons) => ({ to: 'app', text, buttons: buttons || [] });
  const canPush = lead => lead.app && lead.pushOn;

  // ── texts ──
  const HINT = '';   // no "send TEST for the next one": one demo on WhatsApp, the rest in the app
  const freeWhat = lead => lead.kind === 'regular' ? 'free धडे' : 'free tests';
  // the free account: "Code ABC123 · PIN 4821" (PIN '' = the one they chose themselves)
  const acctLine = lead => lead.acct && lead.acct.code ? `👤 Code: *${lead.acct.code}* · 🔑 PIN: *${lead.acct.pin || 'तुमचाच'}*` : '';
  // (no Play link in the text any more: the app goes as its own message with the 📲 button — appPitch)
  const tail = () => '';
  // after CONFIG.waMaxTests links on WhatsApp: the rest of the free part is in the app, or the whole course
  function appOrCourse(lead, now, out, own) {
    lead.appAsked = dayKey(now);
    if (!lead.app) out.push(wa(lead, now, `✅ Demo test झाली. पुढचा सराव *app मध्ये* — ${appLeft(lead)} (app download केल्यावरच सोडवता येतात).${lead.acct && lead.acct.code ? '\n' + acctLine(lead) + '\nApp उघडा → *Login* → Code आणि PIN' : ''}\n${APP_LINE}`, [appBtn(lead)], { own }));
    if (!lead.paid) out.push(wa(lead, now, `🔓 *पूर्ण ${TS(lead)}*${unlockText(lead, now)}\n${PAY_LINE}`, [payBtn(lead, now)], { own }));
    out.push(log('APP', `WhatsApp वर ${CONFIG.waMaxTests} tests झाल्या → app (Code + PIN) किंवा course. पुढच्या tests WhatsApp वर नाहीत.`));
  }
  const offerLine = (lead, now) => { const o = offerNow(lead, now); return o ? `\n🎁 पहिल्या payment वर ${o.pct}% सूट — ${whenText(o.end, now)} पर्यंत.` : ''; };
  const scoreLine = s => s ? `${s.score}/${s.total}${s.rank ? ` · ${s.of} विद्यार्थ्यांमध्ये #${s.rank}` : ''}${s.title ? `\n📝 ${s.title}` : ''}${s.weak ? `\nकमकुवत भाग: ${s.weak}` : ''}` : '';
  // at most 3 (a 4th turns them into a hidden "पर्याय निवडा" list)
  function mainButtons(lead, now) {
    const b = [];
    if (!lead.mtReg) b.push({ id: 'mt_reg', label: '🏆 महा-Test नोंदणी' });
    b.push(INFO);
    if (!lead.paid) { const o = offerNow(lead, now); b.push({ id: 'fee', label: o ? `💳 ${o.pct}% सूट` : '💳 फी' }); }
    if (b.length < 3 && !lead.app) b.push({ id: 'app', label: '📲 App' });
    if (b.length < 3) b.push({ id: 'ask', label: '❓ प्रश्न' });
    return b;
  }
  // ℹ️ the whole Test Series (lines from the server: utils/seriesInfo.js), then the pay / app buttons
  function seriesLines(lead, now) {
    if (lead.series && Array.isArray(lead.series.lines) && lead.series.lines.length) return lead.series.lines.join('\n');
    const price = priceText(lead, false, now);
    return (isExam(lead) ? '🧠 परीक्षेच्या pattern नुसार प्रश्न · प्रत्येक प्रश्नाचं स्पष्टीकरण' : '📒 Notes · स्वाध्याय उत्तरं · सराव tests') +
      '\n🏆 महा-Test — सगळ्यांमध्ये rank\n🧑‍🏫 Digital Teacher · 📊 Me → Analytics · 🔔 आठवण · 📥 Internet शिवाय अभ्यास' + (price ? '\n💳 ' + price : '');
  }
  function infoMsg(lead, now, out) {
    const o = lead.paid ? null : offerNow(lead, now);
    out.push(wa(lead, now, `🎯 *${TS(lead)}*\n${seriesLines(lead, now)}${o ? `\n🎁 पहिल्या payment वर *${o.pct}% सूट* — ${whenText(o.end, now)} पर्यंत` : ''}${lead.paid ? '\n✅ ' + lead.name + ' साठी ही Test Series चालू आहे.' : '\n' + PAY_LINE}`, lead.paid ? [appBtn(lead)] : [payBtn(lead, now)]));
    if (!lead.paid && !lead.app) appPitch(lead, now, out, false, true);
  }
  // 📲 the app's own features — after the first result / the payment (owner: tell them what the app does)
  const FEATURES = '🧑‍🏫 *Digital Teacher* — रोज काय अभ्यास करायचा ते सांगतो\n📊 *Me → Analytics* — कमकुवत chapters आणि progress\n🔔 *Notifications* चालू ठेवा — test, महा-Test आणि result ची आठवण\n📥 Internet नसतानाही अभ्यास';

  // 🔓 the child's own course: what it opens, the price (with the offer while it runs) and the pay link — numbers from Admin
  function unlockText(lead, now) {
    if (lead.paid) return '';
    const o = offerNow(lead, now), on = !!o;
    const price = priceText(lead, on, now);
    const what = (lead.series && lead.series.short) ? '✅ ' + lead.series.short
      : lead.kind === 'regular' ? '✅ सगळ्या विषयांचे धडे: Notes · स्वाध्याय उत्तरं · सराव'
      : `✅ सगळे ${lead.totalTests ? lead.totalTests + ' ' : ''}tests · प्रत्येक प्रश्नाचं स्पष्टीकरण · महा-Test`;
    return `\n${what}` + (price ? `\n💳 ${price}${on ? ` (${o.pct}% सूट ${whenText(o.end, now)} पर्यंत)` : ''}` : '');
  }
  const unlockButtons = (lead, now) => lead.paid ? [{ id: 'ask', label: '❓ प्रश्न' }] : [payBtn(lead, now)];

  // the first WhatsApp answer: full result, offer, share line, then "daily test?"
  function firstAnswer(lead, now, out) {
    lead.courseAsked = true;
    const o = offerNow(lead, now), price = priceText(lead, !!o, now);
    out.push(wa(lead, now, `🎯 ${lead.name} चा result: ${scoreLine(lead.last)}` + (lead.paid ? '' :
      `\n\n🔓 पूर्ण *${TS(lead)}*${lead.series && lead.series.short ? ': ' + lead.series.short : ''}${price ? `\n💳 ${price}` : ''}${o ? `\n🎁 ${o.pct}% सूट ${whenText(o.end, now)} पर्यंत` : ''}\n${PAY_LINE}`),
      lead.paid ? [] : [payBtn(lead, now)], { template: 'utility' }));
    // the app: where the rest of the free tests, the daily test and the offer's reminders are (data: app → 3 of 8 paid, no app → 0 of 23)
    if (!lead.app && !lead.paid) appPitch(lead, now, out, false);
  }
  // 📲 the app, on its own (short): the rest of the free tests there, with the Code + PIN
  // "अजून 20 tests मोफत — फक्त app मध्ये" (owner 2026-11-14: the app's free tests pull parents to install it)
  const appLeft = lead => { const n = Math.max(0, (lead.freeTotal || 0) - (lead.testsDone || 0)); return n ? `अजून ${n} tests मोफत` : 'सराव tests'; };
  function appPitch(lead, now, out, own, brief) {
    const left = lead.freeTotal ? Math.max(0, lead.freeTotal - (lead.testsDone || 0)) : 0;
    lead.appPitchAt = now.toISOString();
    out.push(wa(lead, now, `📲 ${lead.name} साठी *app मध्ये ${appLeft(lead)}* — त्या *फक्त app download केल्यावरच* सोडवता येतात.${brief ? '' : '\n' + FEATURES}` +
      (lead.acct && lead.acct.code ? `\n\n${acctLine(lead)}\nApp उघडा → *Login* → Code आणि PIN` : '') + `\n${APP_LINE}`,
      [appBtn(lead)], { own, template: 'utility' }));
  }
  // one free test link (at most one a day on WhatsApp; Sunday is the महा-Test's day)
  function testLink(lead, now, out, own) {
    if (!lead.cls && !lead.paid) {
      // the class is not known yet (a new number that skipped the class list): ask it, never "0 free tests done"
      if ((lead.courses || []).length) { lead.awaiting = 'cls'; out.push(wa(lead, now, '📝 कोणत्या class ची free test? 👇', clsButtons(lead), { own })); }
      else out.push(wa(lead, now, `📝 Free test (10 मिनिटं, login नाही) — class निवडा 👇\n${CONFIG.site}/student-app/?free=1`, [], { own }));
      return;
    }
    if (lead.paid) { out.push(wa(lead, now, `✅ ${lead.name} ची ${TS(lead)} चालू आहे — सगळे tests app मध्ये.\n${acctLine(lead) ? acctLine(lead) + '\n' : ''}App उघडा → *Login* → Code आणि PIN\n${APP_LINE}`, [appBtn(lead)], { own })); return; }
    if (lead.kind === 'regular' ? lead.freeLessons && lead.lessonsSent >= lead.freeLessons : lead.testsDone >= lead.freeTotal) {
      out.push(wa(lead, now, (lead.kind === 'regular' ? `🎉 ${lead.name} चे सगळे ${lead.freeLessons} नमुना धडे झाले!` : `🎉 ${lead.name} चे सगळे ${lead.freeTotal} सराव tests पूर्ण!`) + `\nपुढचं सगळं *पूर्ण ${TS(lead)}* मध्ये.${unlockText(lead, now)}\n${PAY_LINE}`, [payBtn(lead, now)], { own })); return;
    }
    // the demo is done (on WhatsApp or the website): the rest is in the app or the course — once a day, then quiet
    if (!lead.paid && ((lead.waTests || 0) >= CONFIG.waMaxTests || (lead.testsDone || 0) >= CONFIG.waMaxTests)) {
      if (lead.appAsked === dayKey(now)) { out.push(log('LIMIT', 'Demo test झाली; आज app / course सांगितलं आहे → पुन्हा उत्तर नाही.')); return; }
      appOrCourse(lead, now, out, own); return;
    }
    if (isMtDay(now, lead)) { out.push(wa(lead, now, `🏆 आज महा-Test चा दिवस. ${lead.mtReg ? `${lead.name} ने ${whenText(nextMahaTest(now, lead) || now, now)} ला याच link वरून द्यायचा 👇\n${L.child(lead.gid)}` : 'नोंदणी करायची?'}\nउद्यापासून पुन्हा रोजची free test.`, lead.mtReg ? [] : [{ id: 'mt_reg', label: '🏆 नोंदणी' }], { own })); return; }
    if (lead.testDay === dayKey(now)) {
      const t = CONFIG.dailyTimes.find(x => x.id === lead.daily);
      void t;
      out.push(wa(lead, now, `✅ ${lead.name} ची आजची test झाली आहे. पुढच्या tests *app मध्ये*.${lead.app ? '' : '\n' + APP_LINE}`, lead.app ? [] : [appBtn(lead)], { own }));
      out.push(log('LIMIT', 'WhatsApp वर दिवसाला 1 free test → आजची आधीच दिली.'));
      return;
    }

    lead.testDay = dayKey(now);
    lead.waTests = (lead.waTests || 0) + 1;
    if (lead.kind === 'regular') {
      lead.lessonsSent = (lead.lessonsSent || 0) + 1;
      const bl = [{ id: 'got', label: '👍 पाल्याला दिला' }];
      out.push(wa(lead, now, `📚 ${lead.name} चा आजचा नमुना धडा${lead.freeLessons ? ` (${Math.min(lead.lessonsSent + 1, lead.freeLessons)}/${lead.freeLessons})` : ''} 👇\n📒 Notes · ✍️ स्वाध्याय उत्तरं · 📝 सराव\n${L.child(lead.gid)}\nपुढचे धडे app मध्ये.`, bl, { own }));
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
      (lead.acct && lead.acct.code ? `\n\n📲 App मध्ये पुढच्या ${freeWhat(lead)}: ${acctLine(lead)}` : '')));
  }
  function shareMsg(lead, now, out) {
    lead.shared = true;
    const prizes = CONFIG.prizes.map(p => `${p[0]} मित्र = ${p[1]}`).join(' · ');
    out.push(wa(lead, now, `🎓 NKs EduOrbit च्या Test Series:\n${lead.courses.map(cleanName).join(' · ')}\n\n📲 ओळखीच्या विद्यार्थ्यांना ही link पाठवा 👇\n${L.share(lead.gid)}\n\n🎁 तुमच्या link वरून आलेल्या मित्रांनी pay केलं ${lead.paid ? 'की' : 'आणि तुम्ही pay केलं की'} ते ${lead.name} च्या Refer & Earn मध्ये मोजले जातात: ${prizes}.\nनियम 👉 ${L.rules(lead.gid)}` + HINT,
      [{ id: 'share_done', label: '📲 Share केलं' }, { id: 'rules', label: '📄 नियम पाहा' }]));
    out.push(log('SHARE', 'Courses + share link: दुसऱ्या test नंतर, पालकांच्या reply ला उत्तर म्हणून (मोफत). यादी Admin मधल्या classes मधून.'));
  }
  // ✅ a family that paid: what they paid, the account, how to log in — never "pay" again
  function paidMsg(lead, now, out, again) {
    const p = lead.paidInfo || {};
    const plan = p.period === 'yearly' ? 'Yearly' : p.period === 'monthly' ? 'Monthly' : '';
    const till = p.till ? new Date(p.till) : null;
    const tillText = till && !isNaN(till) ? `${ist(till).getUTCDate()}/${ist(till).getUTCMonth() + 1}/${ist(till).getUTCFullYear()} पर्यंत` : '';
    const code = p.code || (lead.acct && lead.acct.code) || '';
    const pin = lead.acct && lead.acct.code === code && lead.acct.pin ? '*' + lead.acct.pin + '*' : 'तुम्ही ठेवलेला';
    out.push(wa(lead, now, (again ? `✅ हो, ${lead.name} चं payment मिळालं आहे` : `🎉 *${lead.name} चं payment मिळालं`) + (p.amount ? ` — ₹${Number(p.amount).toLocaleString('en-IN')}` : '') + (again ? '' : '*') +
      (plan || tillText ? ` (${[plan, tillText].filter(Boolean).join(', ')})` : '') +
      `\n✅ ${TS(lead)} पूर्ण उघडली.\n\n👤 Student Code: *${code || '—'}*\n🔑 PIN: ${pin}\n📲 App उघडा → *Login* → Code आणि PIN टाका.\nPIN विसरलात? Login वर "📲 WhatsApp ने login".` +
      (again ? '' : `\n\n${FEATURES}`) + teamLine() + `\n${APP_LINE}`, [appBtn(lead)], { template: 'utility' }));
  }
  function offerMsg(lead, now, out) {
    if (lead.paid) { paidMsg(lead, now, out, true); return; }
    lead.payWantAt = now.toISOString();   // 💳 asked for the Test Series here: a warm family for the team
    const o = offerNow(lead, now);
    out.push(wa(lead, now, `🔓 *पूर्ण ${TS(lead)}*${unlockText(lead, now)}${!o && !lead.testsDone && ruleText(lead) ? '\n🎁 ' + ruleText(lead, { short: true }) : ''}\n${PAY_LINE}`, [payBtn(lead, now)]));
  }
  // "pay केलं" / a screenshot: paid → yes, with the account; not yet seen → the team checks at once (red, top of the list)
  function paidClaimMsg(lead, now, out, t) {
    if (lead.paid) { paidMsg(lead, now, out, true); return; }
    lead.crm = 'call'; lead.callAt = now.toISOString(); lead.payIssueAt = now.toISOString();
    out.push(wa(lead, now, `🙏 धन्यवाद! आमच्या system मध्ये अजून ${lead.name} चं payment दिसत नाही.\nPayment पूर्ण झालं असेल तर 5–10 मिनिटांत account आपोआप उघडतं आणि इथे message येतो.\nतसं झालं नाही तर आमची team लगेच तपासून call करेल.${teamLine()}`));
    out.push(log('PAY', `⚠️ पालक म्हणतात pay केलं ("${String(t).slice(0, 60)}"), पण payment दिसत नाही → लगेच तपासा / call करा.`));
  }
  function answer(lead, now, out, text) {
    out.push(wa(lead, now, text, [{ id: 'ok', label: '✅ समाधान झालं' }, { id: 'more', label: '❌ अजून मदत हवी' }]));
  }

  // the महा-Test result (the server sends it as an event; the demo from its timeline)
  function mtResult(lead, now, out, s) {
    lead.mtLast = { score: s.score, total: s.total, rank: s.rank || null, of: s.of || null, at: now.toISOString() };
    out.push(log('MT', `${lead.name} ने महा-Test दिला → ${s.score}/${s.total}.`));
    if (canPush(lead)) out.push(push(`🏆 महा-Test: ${s.score}/${s.total}${s.rank ? ` · #${s.rank} / ${s.of}` : ''}`, lead.paid ? [] : [{ id: 'push:REPORT', label: '📊 WhatsApp वर रिपोर्ट' }]));
    else if (!lead.closed && lead.lastInboundAt) out.push(wa(lead, now, `🏆 ${lead.name} चा महा-Test result\n${scoreLine(s)}\nTop 10 👇 ${L.mt(lead.cls)}` + (lead.paid ? '' : `\n\n🔓 पूर्ण *${TS(lead)}*${unlockText(lead, now)}\n${PAY_LINE}`), lead.paid ? [{ id: 'got', label: '👍' }] : unlockButtons(lead, now), { template: 'utility' }));
    if (!lead.paid && !lead.closed && !lead.stopped && lead.testsDone >= 3 && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', '🔥 रोज tests देतो + महा-Test, pay नाही → गरम call यादी (result नंतर call).')); }
  }

  // ── a family that wrote first from a number the bot does not know (a click-to-WhatsApp ad, or "hi") ──
  // the number is the lead; the class (from the ad, else asked), then the child's name → the child's link + Code + PIN
  // a button's own id coming back is never a name
  const BUTTON_IDS = ['fee', 'keep', 'call_me', 'got', 'mt_reg', 'mt_want', 'ask', 'ok', 'more', 'next', 'app', 'pay', 'share_done', 'rules', 'info'];
  const clsButtons = lead => (lead.courses || []).slice(0, 10).map((c, i) => ({ id: 'cls:' + i, label: cleanName(c) }));
  const TEACHER_BTN = { id: 'teacher', label: '👩‍🏫 मी शिक्षक / Tuition' };
  // "मी शिक्षक आहे", "sir mi teacher ahe", "tuition ghetat" — a teacher, not a parent
  const TEACHER_RX = /(मी|mi|me|i\s*am|i'm)\s*(एक\s*)?(शिक्षक|शिक्षिका|teacher|tuition|ट्युशन|क्लास\s*चालक)|^(शिक्षक|teacher|tuition)(\s*(आहे|ahe|aahe))?$|tuition\s*(ghet|chalav|घेतो|घेते|चालवतो)|(माझा|माझे|maza|maze|majha)\s*(tuition|ट्युशन|classes|क्लासेस)/i;
  function askName(lead, now, out, hello) {
    lead.awaiting = 'name';
    out.push(wa(lead, now, `${hello ? 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\n' : ''}${lead.cls ? TS(lead) + ' ची ' : ''}free test (10 मिनिटं, login नाही) 📝\nResult, क्रमांक आणि कुठे सराव हवा ते इथेच पाठवतो.\n\n✍️ पाल्याचं (मुलाचं / मुलीचं) नाव लिहा 👇`));
  }
  // owner (2026-11-12): a parent from a class's ad is not asked again — the class's test link goes at once (to forward
  // or open here); the child types the name on the website, and the free account (Code + PIN) follows from there
  // 🎯 the course in one message (owner's text 2026-11-14), then "solve the demo, get 50 %"
  function courseInfo(lead, now, hello) {
    const price = priceText(lead, false, now);
    const short = (lead.series && lead.series.short) || (isExam(lead) ? 'परीक्षेच्या pattern नुसार प्रश्न + स्पष्टीकरण · महा-Test' : 'Notes · स्वाध्याय उत्तरं · सराव · महा-Test');
    return `${hello ? 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\n\n' : ''}🎯 *${TS(lead)}*\n✅ ${short}` +
      (price ? `\n💳 ${price.replace(/Monthly /, '').replace(/ · Yearly /, '/महिना · ')} (30 एप्रिलपर्यंत)` : '') +
      (ruleText(lead) ? `\n🎁 *Demo test सोडवा आणि ${lead.offerCfg?.p1 || CONFIG.offerPercent}% सूट मिळवा* 👇` : '\n📝 *Demo test सोडवा* (10 मिनिटं, login नाही) 👇') + (hello ? teamLine() : '');
  }
  function linkFirst(lead, now, out, hello) {
    lead.awaiting = null;
    out.push(wa(lead, now, courseInfo(lead, now, hello), [INFO, { id: 'fee', label: '💳 फी' }]));
    out.push(wa(lead, now, `📝 ${TS(lead)} — demo test (10 मिनिटं, login नाही)\n👇 पाल्याला *forward* करा किंवा याच phone वर उघडा\n${L.child(lead.gid)}\nगुण आणि क्रमांक इथेच येतील.`));
    if (lead.ctwaUntil && !lead.mtReg && lead.mtNext && new Date(lead.mtNext) > now)
      out.push(wa(lead, now, `🏆 ${whenText(new Date(lead.mtNext), now)} ला ${SN(lead)} चा महा-Test — सगळ्यांमध्ये क्रमांक कळेल. नोंदणी करू? (मोफत)`, [{ id: 'mt_reg', label: '🏆 हो, नोंदणी करा' }]));
    out.push(log('CRM', `Class माहीत (${lead.cls}) → test ची link लगेच, काही विचारलं नाही. नाव मूल website वर लिहील; मग app account (Code + PIN) इथे.`));
  }
  // 👩‍🏫 the first message from a teacher ad (index.js newFamily): straight into the teacher's flow
  function teacherWelcome(lead, raw, now) {
    const out = [];
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; lead.via = 'wa'; lead.welcomed = true;
    out.push(log('CRM', '👩‍🏫 Teacher ad मधून पहिला message → शिक्षकाचा flow.'));
    teacherStart(lead, now, out, 'teacher ad');
    return out;
  }
  function welcome(lead, raw, now) {
    const out = [];
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; lead.via = 'wa'; lead.welcomed = true;
    out.push(log('CRM', lead.ctwaUntil ? `💬 WhatsApp ad मधून पहिला message → नंबर आपोआप, lead. ${CONFIG.ctwaHours} तास bot मोफत लिहू शकतो.` : 'नवीन नंबरवरून पहिला message → lead. 24 तास bot मोफत लिहू शकतो.'));
    if (!lead.cls && (lead.courses || []).length) {
      lead.awaiting = 'cls';
      out.push(wa(lead, now, 'नमस्कार 🙏 NKs EduOrbit मध्ये स्वागत!\nपाल्याची free test (10 मिनिटं, login नाही) 📝\nकोणती Test Series? 👇\n(शिक्षक आहात? खालच्या यादीत "👩‍🏫 मी शिक्षक")', [...clsButtons(lead).slice(0, 9), TEACHER_BTN]));
      return out;
    }
    if (lead.cls) linkFirst(lead, now, out, true);
    else { askName(lead, now, out, true); return out; }   // nothing known about the class and no list (Render asleep): the name first
    // the first message was an icebreaker / command (fee, call, महा-Test): answer that too
    const first = alias(String(raw || ''));
    if (['fee', 'call_me', 'mt_reg'].includes(first)) out.push(...inbound0(lead, first, now).filter(x => !(first === 'mt_reg' && x.to === 'wa' && /नोंदणी करू/.test(x.text || ''))));
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
  // "pay kel / payment done / पैसे भरले" — the family says it paid
  const PAID_RX = /pay\s*(kel|kela|keli|kely|kelay|kelel|kele|zal|zala|jhal|jhala|done|kar\s*dia|kiya)|payment\s*(done|zal|zala|jhal|jhala|kel|kela|keli|kely|ho\s*gaya|successful|success|complete|kel\s*aahe)|paid\s*(kel|zal|done)|पैसे\s*भरले|फी\s*भरली|pay\s*केल|payment\s*केल|पेमेंट\s*(केल|झाल)|भरले\s*आहेत/i;
  const paidClaim = t => PAID_RX.test(String(t || '')) || /^\[(image|document)\]$/i.test(String(t || '').trim());
  function meaning(t, lead) {
    const x = t.trim().toLowerCase().replace(/[?!.,🙏]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (PAID_RX.test(x)) return 'paidclaim';
    if (/(call|phone|फोन|कॉल)\s*(nko|nako|naka|nka|नको|नका|nahi|karu\s*naka|करू\s*नका)|(nko|nako|नको)\s*(call|phone|फोन|कॉल)|call\s*karu\s*naka/.test(x)) return 'nocall';
    if (/(free|फ्री|मोफत|फुकट)/.test(x) && /(ahe|aahe|आहे|ka\b|का|nahi|नाही|paise|पैसे|class|क्लास|\?)/.test(t.toLowerCase())) return 'free';
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
  // owner 2026-11-14: the bot answers less — the same words again within 6 h (TEST, hi, the ad's text) get no new
  // answer, and after CONFIG.dailyReplies answered messages in a day the team takes over (one "team will call")
  function inbound(lead, raw, now) {
    if (lead.tdemo) return teacherInbound(lead, raw, now);
    if (!lead.paid && !lead.testsDone && (String(raw || '').trim() === 'teacher' || TEACHER_RX.test(String(raw || '')))) {
      const out = []; lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; teacherStart(lead, now, out, String(raw).trim() === 'teacher' ? 'बटण' : 'मेसेज'); return out;
    }
    const t = String(raw || '').trim().toLowerCase(), day = dayKey(now);
    if (/^(stop|start)$/.test(t)) return inbound0(lead, raw, now);
    if (lead.rDay !== day) { lead.rDay = day; lead.rN = 0; lead.rCapped = false; }
    const again = lead.lastRaw && lead.lastRaw.t === t && now - new Date(lead.lastRaw.at) < 6 * H && !BUTTON_IDS.includes(t) && !/^[a-z_]+:/.test(t);
    lead.lastRaw = { t, at: now.toISOString() };
    if (again || lead.rCapped) {
      lead.lastInboundAt = now.toISOString(); lead.unanswered = 0;   // the window stays open; nothing new to say
      return [log('LIMIT', again ? 'तोच मेसेज 6 तासांत पुन्हा → उत्तर नाही.' : `आज ${CONFIG.dailyReplies} उत्तरं झाली → team कडे (उत्तर नाही).`)];
    }
    const out = inbound0(lead, raw, now);
    const tap = BUTTON_IDS.includes(t) || /^[a-z_]+:/.test(t);
    if (out.some(o => o.to === 'wa') && !tap && !paidClaim(t)) lead.rN++;
    if (lead.rN > CONFIG.dailyReplies) {
      lead.rCapped = true; lead.crm = 'call'; lead.callAt = now.toISOString();
      return [...out.filter(o => o.to !== 'wa'), wa(lead, now, `🙏 तुमचे प्रश्न आमच्या team कडे दिले आहेत — team तुम्हाला लवकरच call करेल.${teamLine()}`),
        log('CALL', `आज ${CONFIG.dailyReplies} पेक्षा जास्त मेसेज → team call करेल (🎯 आजचं काम · 📞).`)];
    }
    return out;
  }
  function inbound0(lead, raw, now) {
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
    if (/^\[(image|document)\]$/i.test(t) && (lead.paid || lead.payWantAt || lead.paySeenAt || lead.checkoutAt)) { paidClaimMsg(lead, now, out, t); return out; }
    if (/^\[(image|document|audio|video)\]$/i.test(t)) { askTeam(lead, now, out, /audio/i.test(t) ? '🎤 Voice message' : /video/i.test(t) ? '🎬 Video' : '📷 फोटो / file पाठवली', false); return out; }
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
      if (!/^[a-z_]+:/i.test(t) && !['TEST', 'STOP'].includes(kw)) { out.push(wa(lead, now, 'खालच्या यादीतून Test Series निवडा 👇', clsButtons(lead))); return out; }
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
      if (m === 'fee' || m === 'pay') { if (m === 'pay') lead.payWantAt = now.toISOString(); return inbound0(lead, m === 'fee' ? 'fee' : 'pay', now); }
      if (m === 'paidclaim') { paidClaimMsg(lead, now, out, t); return out; }
      if (m === 'nocall') {
        lead.noCall = true; if (lead.crm === 'call') lead.crm = null;
        out.push(wa(lead, now, '🙏 ठीक आहे, आम्ही call करणार नाही. काही हवं असेल तर इथेच लिहा.', [INFO]));
        out.push(log('CALL', '🔕 पालक म्हणतात call नको → call यादीतून काढलं.')); return out;
      }
      if (m === 'free') {
        const price = priceText(lead, false, now);
        out.push(wa(lead, now, `🙏 ${TS(lead)}: *1 demo test मोफत*${lead.kind === 'regular' ? ' (आणि काही नमुना धडे)' : ' (आणि app मध्ये काही सराव tests)'}.\nपूर्ण Test Series — सगळे tests, स्पष्टीकरण, महा-Test — याची फी${price ? ': ' + price : ' pay page वर'}.${lead.paid ? '' : '\n' + PAY_LINE}`, lead.paid ? [] : [payBtn(lead, now)]));
        return out;
      }
      if (m === 'TEST') return inbound0(lead, 'TEST', now);
      if (m === 'ok') return inbound0(lead, 'ok', now);
    }
    const gidWord = /^[0-9A-Z]{10}$/.test(up.split(/\s+/)[1] || '');   // LINK / RESULT / VERIFY come from our own links with the code
    if ((kw === 'RESULT' || kw === 'VERIFY') && (gidWord || up === kw)) {
      const first = !lead.via; lead.via = lead.via || 'wa';
      if (first) { out.push({ to: 'do', action: 'lead' }); out.push(log('CRM', 'नंबर WhatsApp वरून आपोआप → lead. Meta ला "Lead".')); }
      if (kw === 'VERIFY') out.push(log('LOGIN', 'नंबर WhatsApp ने पक्का → OTP template नाही (₹0).'));
      firstAnswer(lead, now, out); return out;
    }
    if (kw === 'LINK' && gidWord) {
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
      out.push(wa(lead, now, `✅ नमस्कार! ${lead.name} चा आजचा नमुना धडा झाला.\nपुढचे धडे *app मध्ये*, आणि सगळे धडे *पूर्ण ${TS(lead)}* मध्ये:` + unlockText(lead, now) + `\n${PAY_LINE}`, unlockButtons(lead, now), { template: 'utility' }));
      if (!lead.app) appPitch(lead, now, out, false);
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
      out.push(log(kw === 'PUSH' ? 'PUSH' : 'TEST', kw === 'PUSH' ? 'Push चं 💬 WhatsApp बटण → खिडकी 24 तास.' : 'पालकाने स्वतः TEST मागितलं → मोफत, खिडकी 24 तास.')); return out; }
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
    if (t === 'info') { infoMsg(lead, now, out); return out; }
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
      // (an old button: the daily test / lesson is in the app now — no promise of a WhatsApp one)
      out.push(wa(lead, now, `🙏 ठीक आहे. पुढच्या ${freeWhat(lead)} आणि रोजची आठवण *app मध्ये* येईल. ${mtLeft(now, lead)}${lead.app ? '' : '\n' + APP_LINE}`, lead.app ? [] : [appBtn(lead)]));
      out.push(log('CRM', c ? `रोजची वेळ ${c.h - 12} वाजता निवडली → app मधून आठवण.` : 'रोजची test नको.'));
      return out;
    }
    if (t === 'app') { appPitch(lead, now, out, false); return out; }
    if (t === 'keep') { out.push(wa(lead, now, `👍 ठीक आहे! ${lead.name} चे result, पुढची free test आणि महा-Test ची आठवण इथेच येईल. कधीही *TEST* पाठवा.`)); out.push(log('CTWA', 'पालकांनी "आठवण हवी" दाबलं → खिडकी पुन्हा 24 तास.')); return out; }
    if (t === 'got') { out.push(wa(lead, now, '👍 Test झाली की result इथे येईल.')); return out; }
    if (t === 'next') { out.push(wa(lead, now, `👍 पुढच्या tests *app मध्ये* आहेत.${lead.app ? '' : '\n' + APP_LINE}`, lead.app ? [] : [appBtn(lead)])); if (!lead.shared && lead.testsDone >= 2) shareMsg(lead, now, out); return out; }
    if (t === 'ask') { out.push(wa(lead, now, 'कोणता प्रश्न?', [{ id: 'ask:fee', label: 'फी किती?' }, { id: 'ask:app', label: 'App कसा वापरायचा?' }, { id: 'ask:other', label: '💬 दुसरा प्रश्न' }])); return out; }
    if (t === 'ask:other') { lead.awaiting = 'question'; out.push(wa(lead, now, '✍️ तुमचा प्रश्न लिहा 👇')); return out; }
    if (t === 'fee' || t === 'ask:fee') { offerMsg(lead, now, out); return out; }
    if (t === 'ask:app') { if (lead.acct && lead.acct.code) answer(lead, now, out, `App download करा → *Login* → ${acctLine(lead)} → Home वर "पुढचा test". PIN विसरलात तर Login वर "📲 WhatsApp ने login".`); else appPitch(lead, now, out, false); return out; }
    if (t === 'ask:pin') { answer(lead, now, out, 'App → Login → "📲 WhatsApp ने login" → नवीन PIN. 1 मिनिट.'); return out; }
    if (t === 'ask:open') { answer(lead, now, out, 'App update करा (Play Store) आणि internet चालू ठेवून एकदा उघडा.'); return out; }
    if (t === 'ok') { out.push(wa(lead, now, 'धन्यवाद 🙏', mainButtons(lead, now))); return out; }
    if (t === 'more' || t === 'call_me') { lead.crm = 'call'; lead.callAt = now.toISOString(); out.push(wa(lead, now, '🙏 धन्यवाद! आमची team तुम्हाला लवकरच call करेल.')); out.push(log('CALL', '📞 Call request → Admin › CRM "Call करायचे" (वरती) + लाल संख्या.')); return out; }
    if (t === 'share_done') { out.push(wa(lead, now, '🙏 धन्यवाद! मित्रांनी pay केलं की तुमच्या Refer & Earn मध्ये दिसेल 👉 ' + L.rules(lead.gid))); out.push(log('SHARE', `मित्र आला की "कोणाकडून" नोंद (ref=${lead.gid}). Free असताना मित्र राखून ठेवले जातात; pay केल्यावर मोजले जातात.`)); return out; }
    if (t === 'rules') { out.push(wa(lead, now, `📄 ${L.rules(lead.gid)}\nमित्राने pay केलं तरच मोजला जातो · pay नंतर 7 दिवसांनी पक्का · तुम्ही free असताना आलेले मित्र तुम्ही pay केल्यावर मोजले जातात · तुमच्याच नंबरवरून नाही · बक्षिसासाठी पालकांची संमती + पत्ता.`)); return out; }
    if (/^q:[A-D]$/.test(t)) { const okA = t === 'q:B'; out.push(wa(lead, now, (okA ? '✅ बरोबर! फरक 4, 6, 8, 10 → 30.' : 'थोडं चुकलं 🙂 फरक 4, 6, 8 → पुढचा 10 → 30 (B).') + `\nअसे रोजचे प्रश्न ${TS(lead)} मध्ये.` + offerLine(lead, now), mainButtons(lead, now))); return out; }
    // a parent's own words the bot cannot answer: a question for the team (not a stray button id / one letter)
    if (t.length >= 3 && !/^[a-z_]+(:[\w-]+)?$/i.test(t)) { askTeam(lead, now, out, t, false); return out; }
    out.push(wa(lead, now, 'माफ करा, समजलं नाही 🙏 खालचं बटण दाबा किंवा TEST पाठवा.', mainButtons(lead, now)));
    return out;
  }

  // ── what happened elsewhere (website, app, payment, Admin) ──
  function event(lead, type, data, now) {
    const out = [];
    data = data || {};
    if (type === 'tdemo') return teacherEvent(lead, data, now);   // 👩‍🏫 Teacher Guide
    if (type === 'test_done') {
      // data.n = the server's own count of this child's tests (the event may arrive after a sync that already counted it)
      const first = !lead.firstTestAt || data.n === 1;
      lead.testsDone = data.n || lead.testsDone + 1; lead.last = data;
      lead.testDay = dayKey(now);   // one free test a day, wherever it was taken (website or WhatsApp link)
      if (first) {
        if (!lead.firstTestAt) lead.firstTestAt = now.toISOString();
        if (!lead.offerEnd && !lead.srvOffer) lead.offerEnd = new Date(new Date(lead.firstTestAt).getTime() + CONFIG.offerHours * H).toISOString();
        const o0 = offerNow(lead, now);
        out.push(log('OFFER', o0 ? `पहिली test → ${o0.name ? o0.name + ': ' : ''}${o0.pct}% सूट ${whenText(o0.end, now)} पर्यंत.` : 'पहिली test → सूट नाही (Admin ने सूट बंद ठेवली आहे / आधीच मिळाली).'));
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
    if (type === 'sync' && lead.tdemo) return out;   // 👩‍🏫 a teacher's lead: no family facts from the server
    if (type === 'sync') {
      // fresh facts from the server (name, class, free tests, courses, prices, next महा-Test, paid, app…); no message
      const hadAcct = !!(lead.acct && lead.acct.code);
      for (const k of ['desk', 'series', 'subjects', 'prevPapers', 'name', 'cls', 'freeTotal', 'totalTests', 'kind', 'freeLessons', 'courses', 'prices', 'mtNext', 'mtReg', 'paid', 'app', 'pushOn', 'mobile', 'testsDone', 'acct', 'teamOffer', 'srvOffer', 'offerCfg']) if (data[k] !== undefined && data[k] !== null && !((k === 'cls' || k === 'name') && !data[k])) lead[k] = data[k];
      // a family that started on WhatsApp: the free account comes after the name — one message with it
      if (!hadAcct && lead.acct && lead.acct.code && lead.acct.pin && lead.welcomed && !lead.awaiting && !lead.app && !lead.paid && isOpen(lead, now))
        out.push(wa(lead, now, `📲 ${lead.name} चं app account पण तयार — app मध्ये ${appLeft(lead)} (फक्त app download केल्यावर), रोजची आठवण app मधून:\n${acctLine(lead)}\nApp 👇 Login → Code आणि PIN टाका\n${CONFIG.play}`));
      if (data.firstTestAt && !lead.firstTestAt) { lead.firstTestAt = data.firstTestAt; lead.offerEnd = data.offerEnd || (lead.srvOffer ? null : new Date(new Date(data.firstTestAt).getTime() + CONFIG.offerHours * H).toISOString()); }
      // the server's offer: the reminders' clock follows its first step (none when stopped / off)
      if (data.srvOffer) { const s1 = (data.srvOffer.steps || []).find(x => x.stage === 1); lead.offerEnd = s1 ? s1.end : null; }
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
      // one message per payment (the server may report the same payment more than once: verify + webhook)
      const key = data.pay_id || (data.code || '') + ':' + (data.amount || '');
      const seen = lead.paidKeys || (lead.paidKeys = []);
      const dup = seen.includes(key) || (lead.paidMsgAt && now - new Date(lead.paidMsgAt) < 30 * 60e3 && !data.pay_id);
      lead.paid = true; lead.crm = 'paid';
      lead.paidInfo = { code: data.code || '', amount: data.amount || 0, period: data.period || '', till: data.till || null };
      if (dup) { out.push(log('PAY', 'तेच payment पुन्हा कळवलं → message पुन्हा पाठवला नाही.')); return out; }
      seen.push(key); if (seen.length > 10) seen.shift();
      lead.paidMsgAt = now.toISOString();
      paidMsg(lead, now, out, false);
      out.push(log('PAY', `Payment${data.amount ? ' ₹' + data.amount : ''} → account active. सूट आणि pay चे मेसेज बंद; पुढे push फक्त app मध्ये.`));
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

  // ── 👩‍🏫 Teacher Guide (owner 2026-11-26): a teacher on WhatsApp (a teacher ad, "मी शिक्षक", or the /book-demo page)
  // gets a real teacher account (on until the Admin switches it off) and a real student account for 3 days, then the
  // app shown in 7 small steps, one at a time, each with its page on nkseduorbit.in/teacher-guide and ✅ / ❓ buttons.
  // The app tells the bot what the teacher did (login, paper, the demo student's test, students added) and the bot
  // moves on by itself. Stuck → one reminder, then the team calls (Call desk + a push on the team's phones).
  // No reply limits for teachers. Words: only "सूट" (never a percent, commission, earnings or "free"); the सूट's
  // details on the team's number.
  const TEAM_NO = '8390484545';
  const TDEMO_DID = { tLogin: '✅ शिक्षक login झाला', sLogin: '✅ demo विद्यार्थी login झाला', paperAt: '📄 पहिला पेपर बनवला', sTestAt: '📝 demo विद्यार्थ्याने test दिला', orderAt: '💳 विद्यार्थ्यांची पहिली order' };
  const guide = id => `${CONFIG.site}/teacher-guide#${id}`;
  const pinOf = p => (p ? `*${p}*` : 'तुमचाच');
  const TSTEPS = [
    { id: 'login', did: 'tLogin', title: 'Login', text: d => `*Step 1/7 · Login 🔑*\nApp उघडा → 👩‍🏫 *Teacher* निवडा → Code *${d.tCode}* · PIN ${pinOf(d.tPin)} → Login.` },
    { id: 'paper', did: 'paperAt', title: 'पेपर', text: () => '*Step 2/7 · 1 मिनिटात पेपर 📄*\nवरचं ▾ menu → 📄 *Paper* → वर्ग, विषय आणि धडे निवडा → *पेपर बनवा* → PDF आणि Answer key.' },
    { id: 'students', title: 'विद्यार्थी', text: d => `*Step 3/7 · तुमचे विद्यार्थी 👨‍🎓*\n▾ → 👨‍🎓 *Students* — तुमचा demo विद्यार्थी *${d.sCode || ''}* इथे दिसतो.\nतुमच्या वर्गाची link / QR: ▾ → 📤 *Share* → मुलं थेट तुमच्याशी जोडली जातात.` },
    { id: 'student', did: 'sTestAt', title: 'विद्यार्थी test', text: d => `*Step 4/7 · विद्यार्थी बनून पाहा 🎓*\nवरती तुमचं नाव (Profile) → ↔ *Switch Account* → 🎓 *Student* → Code *${d.sCode || ''}* · PIN ${pinOf(d.sPin)} → कोणताही एक धडा → *Test* द्या.` },
    { id: 'analytics', title: 'Analytics', text: () => '*Step 5/7 · गुण तुमच्या phone वर 📊*\nपरत ↔ Switch Account → 👩‍🏫 Teacher → ▾ → 📊 *Analytics* → त्या विद्यार्थ्याचे गुण आणि कमी पडलेले धडे.\nतुमच्या प्रत्येक विद्यार्थ्याचं असंच दिसेल.' },
    { id: 'tour', title: 'Videos · Notify · Fee', text: () => '*Step 6/7 · आणखी काही ✨*\n🎬 *Videos* — तुमचे YouTube videos फक्त तुमच्या विद्यार्थ्यांना\n🔔 *Notify* — पालकांना एका क्लिकमध्ये सूचना\n💰 *Fee* — फी ची नोंद\n📚 *Books* — पुस्तकं' },
    { id: 'offer', did: 'orderAt', title: 'खास सूट', text: () => `*Step 7/7 · शिक्षकांसाठी खास सूट 🎁*\nतुमच्या विद्यार्थ्यांची accounts ▾ → ➕ *Students बनवा* मधून घ्या — शिक्षकांसाठी *खास सूट*.\nसूट ची माहिती आणि मदत: 📞 *${TEAM_NO}*` },
  ];
  const STEP_BTNS = [{ id: 'ts:done', label: '✅ झालं' }, { id: 'ts:help', label: '❓ अडचण' }];
  const CALL_BTN = { id: 'ts:call', label: '📞 Team ने call करावा' };
  const tsay = (lead, now, out, text, buttons) => { if (isOpen(lead, now)) out.push(wa(lead, now, text, buttons)); else out.push(log('₹ नाही', 'खिडकी बंद → संदेश नाही (team call करू शकते).')); };
  const tcall = (lead, now, out, why) => { lead.crm = 'call'; lead.callAt = now.toISOString(); lead.tdemo.callWhy = why; out.push(log('CALL', '👩‍🏫 ' + why)); };
  const tpush = (out, now, lead, title, text) => out.push({ to: 'do', action: 'team_push', data: { title, text, one: lead.gid, at: now.getTime() } });
  const untilText = d => (d.until ? new Date(d.until).toLocaleString('mr-IN-u-nu-latn', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : '');
  function codesText(lead) {
    const d = lead.tdemo;
    return `🎉 तयार${lead.name ? ', ' + lead.name : ''}!\n\n👩‍🏫 *शिक्षक* — Code: *${d.tCode}* · PIN: ${pinOf(d.tPin)}` +
      (d.sCode ? `\n🎓 *विद्यार्थी account*${d.course ? ' (' + cleanName(d.course) + ')' : ''} — Code: *${d.sCode}* · PIN: ${pinOf(d.sPin)}${d.until ? '\n   पूर्ण account — ' + untilText(d) + ' पर्यंत (रविवार) चालू' : ''}` : '') +
      `\n\n📲 App: ${CONFIG.play}\n\nआता 7 छोट्या steps — प्रत्येक 1–2 मिनिटं. मी एक-एक सांगतो 👇`;
  }
  // the current step, skipping what the app already said is done
  function stepMsg(lead, now, out) {
    const d = lead.tdemo;
    while (d.step < TSTEPS.length && TSTEPS[d.step].did && d[TSTEPS[d.step].did]) d.step++;
    if (d.step >= TSTEPS.length) { tfinish(lead, now, out); return; }
    const s = TSTEPS[d.step];
    d.stepAt = now.toISOString(); d.rem = 0;
    tsay(lead, now, out, `${s.text(d)}\n📷 कसं दिसतं: ${guide(s.id)}`, s.id === 'offer' ? [CALL_BTN] : STEP_BTNS);
    out.push(log('TSTEP', `Step ${d.step + 1}/7 (${s.title}) पाठवली.`));
  }
  const PRAISE = { login: '👏 Login झालं!', paper: '👏 छान! पहिला पेपर तयार.', students: '👍 ठीक आहे.', student: '🎉 Test दिला — आता त्याचे गुण तुमच्या phone वर पाहू.', analytics: '👍 तुमच्या प्रत्येक विद्यार्थ्याचं असंच दिसेल.', tour: '👍' };
  function stepDone(lead, now, out, how) {
    const d = lead.tdemo, s = TSTEPS[d.step];
    if (!s) return;
    if (s.id === 'offer') { tsay(lead, now, out, `🙏 Students बनवताना मदत हवी असेल तर 📞 ${TEAM_NO}`, [CALL_BTN]); return; }
    out.push(log('TSTEP', `Step ${d.step + 1} (${s.title}) झाली — ${how}.`));
    d.step++; d.stuck = null;
    tsay(lead, now, out, PRAISE[s.id] || '👍');
    stepMsg(lead, now, out);
  }
  function tfinish(lead, now, out) {
    const d = lead.tdemo;
    if (d.doneAt) return;
    d.doneAt = now.toISOString(); d.stuck = null; d.step = TSTEPS.length;
    tsay(lead, now, out, `🎉 अभिनंदन${lead.name ? ' ' + lead.name : ''}! तुमचे विद्यार्थी app वर आले.\nत्यांचे Code + PIN तुमच्या 👨‍🎓 Students मध्ये आहेत. पेपर, tests आणि गुण — सगळं एका ठिकाणी.\nमदत: 📞 ${TEAM_NO}`);
    lead.crm = 'hot';
    tpush(out, now, lead, '🎉 शिक्षकाने विद्यार्थी जोडले', `${lead.name || 'शिक्षक'}${d.added ? ' · ' + d.added + ' विद्यार्थी' : ''}`);
  }
  // the teacher's class, then the name + school, then the accounts (Render makes them: 'teacher_account')
  function teacherStart(lead, now, out, how) {
    lead.tdemo = Object.assign(lead.tdemo || {}, { via: lead.tdemo?.via || 'bot', stage: 'cls', startedAt: now.toISOString(), step: 0 });
    lead.cls = 'Teacher (bot)'; lead.awaiting = null;
    out.push(log('TDEMO', `👩‍🏫 शिक्षक (${how}) → वर्ग विचारला.`));
    const rows = (lead.courses || []).slice(0, 10).map((c, i) => ({ id: 'tcls:' + i, label: cleanName(c) }));
    out.push(wa(lead, now, `नमस्कार 🙏 शिक्षकांचं स्वागत!\nतुमच्यासाठी *शिक्षक account* आणि 3 दिवसांसाठी एक *demo विद्यार्थी* बनवतो — app तुम्ही स्वतः वापरून पाहा.\n\nतुम्ही कोणत्या वर्गाला शिकवता?${rows.length ? ' 👇' : ' (उदा. 8वी NMMS)'}`, rows));
  }
  function askTeacherName(lead, now, out) {
    lead.tdemo.stage = 'name';
    out.push(wa(lead, now, 'तुमचं नाव आणि शाळा / क्लास, गाव एका ओळीत लिहा ✍️\nउदा. संजय पाटील, जि. प. शाळा कागल'));
  }
  function teacherInbound(lead, raw, now) {
    const out = [];
    const t = String(raw || '').trim(), up = t.toUpperCase();
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0;
    if (up === 'STOP') { lead.closed = 'STOP'; lead.stopped = true; out.push({ to: 'wa', kind: 'service', cost: 0, text: '🙏 ठीक आहे, आता मेसेज बंद. पुन्हा हवं असेल तर START पाठवा.', buttons: [] }); return out; }
    if (up === 'START' && lead.closed === 'STOP') { lead.closed = null; lead.stopped = false; }
    if (/^\[(reaction|sticker|unsupported|unknown)\]$/i.test(t)) return out;
    const d = lead.tdemo;
    // a teacher who booked on the website (codes known): the steps start with this first message
    if (!d.stage && d.tCode) { d.stage = 'steps'; d.step = 0; d.welcomedAt = now.toISOString(); out.push(wa(lead, now, codesText(lead))); stepMsg(lead, now, out); return out; }
    if (d.stage === 'cls') {
      const m = t.match(/^tcls:(\d+)$/);
      d.course = m ? (lead.courses || [])[Number(m[1])] || '' : t.slice(0, 80);
      askTeacherName(lead, now, out); return out;
    }
    if (d.stage === 'name') {
      if (/^[a-z_]+:/i.test(t) || t.length < 3) { askTeacherName(lead, now, out); return out; }
      const [nm, ...rest] = t.split(/[,،|\n]/);
      const name = nm.replace(/\s+/g, ' ').trim().slice(0, 60), school = rest.join(', ').replace(/\s+/g, ' ').trim().slice(0, 80);
      lead.name = name; d.school = school; d.stage = 'making'; d.askedAt = now.toISOString();
      out.push({ to: 'do', action: 'teacher_account', name, data: { school: school || name, course: d.course || '', ad: lead.ctwaAd || '' } });
      out.push(wa(lead, now, '⏳ तुमचं account बनवत आहे — 1 मिनिट…'));
      out.push(log('TDEMO', `नाव "${name}"${school ? ', ' + school : ''} → Render ला account बनवायला सांगितलं.`));
      return out;
    }
    if (d.stage === 'making') { out.push(wa(lead, now, `⏳ account बनत आहे — थोडं थांबा. उशीर झाला तर 📞 ${TEAM_NO}`)); return out; }
    // the steps
    if (t === 'ts:done') { stepDone(lead, now, out, '✅ बटण'); return out; }
    if (t === 'ts:help') { d.help = now.toISOString(); out.push(wa(lead, now, 'काय अडचण आहे? एका ओळीत लिहा 🙂')); return out; }
    if (t === 'ts:call' || /^(call|कॉल|फोन)/i.test(t)) {
      const s = TSTEPS[Math.min(d.step || 0, TSTEPS.length - 1)];
      tcall(lead, now, out, s.id === 'offer' ? 'सूट / Students बनवा बद्दल बोलायचं' : `Step ${d.step + 1} (${s.title}) — call मागितला`);
      tpush(out, now, lead, '📞 शिक्षक call मागतात', `${lead.name || 'शिक्षक'} · ${d.callWhy}`);
      out.push(wa(lead, now, `🙏 ठीक आहे — आमची team लवकरच call करेल.\nलगेच बोलायचं असेल तर 📞 ${TEAM_NO}`));
      return out;
    }
    if (/^(DEMO|CODE|PIN)\b/.test(up)) { out.push(wa(lead, now, codesText(lead))); return out; }
    if (/^[a-z_]+:/i.test(t)) return out;
    // a question: the AI answers (index.js aiTry); else the team
    const s = TSTEPS[Math.min(d.step || 0, TSTEPS.length - 1)];
    const q = log('Q', `❓ शिक्षकाचा प्रश्न (Step ${(d.step || 0) + 1} ${s.title}): "${t.slice(0, 300)}"`); q.qa = { text: t.slice(0, 300), teacher: true, prev: lead.question || null };
    lead.question = { text: t.slice(0, 300), at: now.toISOString() };
    const w = wa(lead, now, `🙏 तुमचा प्रश्न आमच्या team कडे दिला — team लवकरच call करेल.\nलगेच: 📞 ${TEAM_NO}`, [CALL_BTN]); w.qa = true;
    out.push(q, w);
    return out;
  }
  // the app / Render told the bot something (index.js /event 'tdemo')
  function teacherEvent(lead, data, now) {
    const out = [];
    const d = lead.tdemo || (lead.tdemo = {});
    if (data.account) {
      const a = data.account;
      if (a.exists && d.tCode) return out;   // a retried job after the codes already came
      Object.assign(d, { tCode: a.tCode || d.tCode, tPin: a.tPin || d.tPin || '', sCode: a.sCode || d.sCode || '', sPin: a.sPin || d.sPin || '', course: a.course || d.course || '', until: a.until || d.until || null, bookedAt: d.bookedAt || now.toISOString() });
      d.stage = 'steps'; d.step = 0;
      out.push(log('TDEMO', a.exists ? `हा नंबर आधीच शिक्षक (${d.tCode}) → नवीन account नाही.` : `Accounts: शिक्षक ${d.tCode} · demo विद्यार्थी ${d.sCode} (3 दिवस).`));
      tsay(lead, now, out, a.exists ? `🙏 तुमचं शिक्षक account आधीच आहे — Code: *${d.tCode}*${d.sCode ? '\n🎓 Demo विद्यार्थी: *' + d.sCode + '*' : ''}\nPIN आठवत नसेल तर 📞 ${TEAM_NO}\n\nApp चे steps 👇` : codesText(lead));
      tpush(out, now, lead, '🆕 नवीन शिक्षक — account दिलं', `${lead.name || 'शिक्षक'}${d.course ? ' · ' + cleanName(d.course) : ''}${d.school ? ' · ' + d.school : ''}`);
      stepMsg(lead, now, out);
      return out;
    }
    if (data.accountError) {
      d.stage = 'name';
      out.push(log('TDEMO', `Account झालं नाही: ${data.accountError}`));
      tsay(lead, now, out, `🙏 ${data.accountError}\nमदत: 📞 ${TEAM_NO}`);
      tcall(lead, now, out, 'Account बनलं नाही: ' + String(data.accountError).slice(0, 80));
      return out;
    }
    const seen = k => { if (!d[k]) { d[k] = now.toISOString(); out.push(log('TDEMO', TDEMO_DID[k] || k)); return true; } return false; };
    if (data.tLogin) seen('tLogin');
    if (data.sLogin) seen('sLogin');
    if (data.paper) { d.papers = (d.papers || 0) + 1; seen('paperAt'); }
    if (data.sTest) { d.sTests = (d.sTests || 0) + 1; seen('sTestAt'); }
    if (data.order) { d.orders = (d.orders || 0) + 1; d.added = (d.added || 0) + (Number(data.added) || 0); d.paidRs = (d.paidRs || 0) + (Number(data.order) || 0); seen('orderAt'); lead.crm = 'hot'; }
    if (data.again) out.push(log('TDEMO', 'हाच नंबर पुन्हा demo बुक करायला आला (नवीन code नाही) → call करा.'));
    // the current step done in the app: on to the next one (the teacher pressed nothing)
    if (d.stage === 'steps' && !d.doneAt) {
      const s = TSTEPS[d.step];
      if (d.orderAt) { if (s && s.id !== 'offer') out.push(log('TSTEP', 'Order झाली → शेवट.')); tfinish(lead, now, out); }
      else if (s && s.did && d[s.did]) { out.push(log('TSTEP', `App ने सांगितलं: Step ${d.step + 1} (${s.title}) झाली.`)); d.step++; d.stuck = null; tsay(lead, now, out, PRAISE[s.id] || '👍'); stepMsg(lead, now, out); }
    }
    return out;
  }
  // the team (Team app "✅ Step पूर्ण करून दिली"): the next step now
  function teacherTeamStep(lead, now) {
    const out = [];
    if (lead.tdemo && lead.tdemo.stage === 'steps' && !lead.tdemo.doneAt) stepDone(lead, now, out, 'team ने call वर करून दिली');
    return out;
  }
  // a quiet hour: a reminder before an end moves earlier (that evening), one after moves to 9 am
  const prevDay = at => (quiet(at) ? (hourOf(at) >= CONFIG.quiet.from ? atIST(at, CONFIG.quiet.from - 1, 0, 0) : atIST(at, CONFIG.quiet.from - 1, 0, -1)) : at);
  const nextDay = at => (quiet(at) ? (hourOf(at) >= CONFIG.quiet.from ? atIST(at, 9, 0, 1) : atIST(at, 9, 0, 0)) : at);
  function teacherItems(lead, items) {
    const d = lead.tdemo;
    if (!d || lead.closed) return;
    const msg = (key, at, fn) => items.push({ key: 't:' + key, at, run: fn });
    // stuck on a step: one reminder after 3 h (inside the window, not at night), then the team
    if (d.stage === 'steps' && !d.doneAt && d.stepAt && d.step < TSTEPS.length) {
      const s = TSTEPS[d.step], at = new Date(d.stepAt), k = d.step + ':' + d.stepAt;
      msg('rem:' + k, nextDay(new Date(at.getTime() + 3 * H)), (out, now) => {
        if (d.step !== TSTEPS.indexOf(s) || (s.did && d[s.did])) return;
        d.rem = 1;
        tsay(lead, now, out, `आठवण 🙂 *Step ${d.step + 1}* — ${s.title} राहिलं आहे, 1–2 मिनिटं लागतील.\n📷 ${guide(s.id)}`, s.id === 'offer' ? [CALL_BTN] : STEP_BTNS);
      });
      msg('stuck:' + k, nextDay(new Date(at.getTime() + 6 * H)), (out, now) => {
        if (d.step !== TSTEPS.indexOf(s) || (s.did && d[s.did])) return;
        d.stuck = { step: d.step, title: s.title, at: now.toISOString() };
        tcall(lead, now, out, `Step ${d.step + 1} (${s.title}) वर अडकले`);
        tpush(out, now, lead, '⚠️ शिक्षक अडकले — call करा', `${lead.name || 'शिक्षक'} · Step ${d.step + 1} ${s.title}`);
      });
    }
    // waiting for the account (Render asleep for long): the team
    if (d.stage === 'making' && d.askedAt) msg('making', new Date(new Date(d.askedAt).getTime() + 30 * 60e3), (out, now) => {
      if (d.stage === 'making') tcall(lead, now, out, 'Account अजून बनलं नाही (30 मिनिटं)');
    });
    // the student account till Sunday night (owner 2026-11-27; was the demo student's 3 days)
    if (d.until && !d.orderAt) {
      const end = new Date(d.until);
      msg('end-12h', prevDay(new Date(end.getTime() - 12 * H)), (out, now) => {
        if (d.orderAt) return;
        tsay(lead, now, out, `⏰ विद्यार्थी account *${d.sCode}* ${untilText(d)} ला बंद होईल (तुमच्या वर्गाचे 10 विद्यार्थी pay झाले की परत चालू).\nतुमच्या विद्यार्थ्यांची accounts: ▾ → ➕ *Students बनवा* — शिक्षकांसाठी खास सूट.\nमाहिती: 📞 ${TEAM_NO}`, [CALL_BTN]);
        tcall(lead, now, out, 'Demo विद्यार्थी उद्या बंद — अजून विद्यार्थी जोडले नाहीत');
      });
      msg('end', nextDay(new Date(end.getTime() + 15 * 60e3)), (out, now) => {
        if (d.orderAt) return;
        tsay(lead, now, out, `🙏 Demo विद्यार्थी बंद झाला. तुमचं *शिक्षक account चालूच* आहे — पेपर बनवा, Videos टाका, विद्यार्थी जोडा.\nतुमचे 10 विद्यार्थी झाले की demo विद्यार्थी परत चालू होतो.\nखास सूट ची माहिती: 📞 ${TEAM_NO}`);
      });
    }
    const booked = d.bookedAt ? new Date(d.bookedAt) : null;
    if (booked) for (const [k, days] of [['d4', 4], ['d7', 7]]) msg(k, atIST(booked, 11, 0, days), (out, now) => {
      if (d.orderAt) return;
      if (isOpen(lead, now)) tsay(lead, now, out, `नमस्कार${lead.name ? ' ' + lead.name : ''} 🙏 तुमच्या वर्गासाठी NKs EduOrbit कसं वाटलं? विद्यार्थी जोडायला मदत हवी असेल तर 📞 ${TEAM_NO}`, [CALL_BTN]);
      else tcall(lead, now, out, `${days} दिवस: विद्यार्थी जोडले नाहीत`);
    });
  }

  // ── the bot's own schedule ──
  // every item: { key, at, run(out) }; tick() runs the due ones once, nextDue() tells when to call again
  function plan(lead) {
    const items = [];
    if (lead.closed === 'STOP') return items;
    if (lead.tdemo) { teacherItems(lead, items); return items; }
    if (!lead.firstTestAt) { if (lead.ctwaUntil) ctwaItems(lead, items); return items; }
    const first = new Date(lead.firstTestAt), offerEnd = new Date(lead.offerEnd);
    const hasWa = !!lead.lastInboundAt;
    // 1) pay nudges inside the offer (never as paid templates)
    const nudge = (key, at, fn) => { if (!lead.paid && !quiet(at) && at < offerEnd) items.push({ key, at, run: fn }); };
    nudge('nudge1', new Date(first.getTime() + H), (out, now) => {
      if (lead.lastInboundAt && now - new Date(lead.lastInboundAt) < 0.8 * H) return;   // just talked
      // no app yet: the next test is waiting there (the app is where families pay: 3 of 8 vs 0 of 23)
      if (!lead.app && isOpen(lead, now)) { if (!lead.appPitchAt || now - new Date(lead.appPitchAt) > 20 * H) appPitch(lead, now, out, true); return; }
      if (isOpen(lead, now)) out.push(wa(lead, now, (lead.last?.weak ? `${lead.name} चा कमकुवत भाग: ${lead.last.weak} 📐\n${TS(lead)} मध्ये या भागाचे सराव tests आणि प्रत्येक प्रश्नाचं स्पष्टीकरण.` : `📚 ${lead.name} साठी पूर्ण ${TS(lead)}:${unlockText(lead, now)}`) + `\n${PAY_LINE}`, [payBtn(lead, now)], { own: true }));
      else if (canPush(lead)) out.push(push(lead.last?.weak ? `${lead.name} चा कमकुवत भाग: ${lead.last.weak} — सराव पाहा` : `${lead.name} साठी सगळ्या chapters चा सराव — पाहा`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
    });
    nudge('nudge2', atIST(first, 8, 0, 1), (out, now) => {
      if (isOpen(lead, now)) out.push(wa(lead, now, `🌅 सुप्रभात! ${lead.name} साठी आजचा प्रश्न 👇\nमालिका: 2, 6, 12, 20, ?\nA) 28  B) 30  C) 32` + offerLine(lead, now), ['A', 'B', 'C'].map(x => ({ id: 'q:' + x, label: x })), { own: true }));
      else if (canPush(lead)) out.push(push(`🌅 आजचा प्रश्न — 1 मिनिट${offerLine(lead, now).replace('\n', ' · ')}`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
    });
    nudge('nudge3', new Date(offerEnd.getTime() - 3 * H), (out, now) => {
      const o2 = offerNow(lead, new Date(offerEnd.getTime() + 60e3)), o1 = offerNow(lead, now);
      if (!o1) return;   // stopped meanwhile (Admin)
      if (isOpen(lead, now)) out.push(wa(lead, now, `⏳ ${o1.pct}% सूट 3 तासांत संपेल${priceText(lead, true, now) ? ' (' + priceText(lead, true, now) + ')' : ''}.${o2 ? `\nत्यानंतर ${whenText(o2.end, now)} पर्यंत ${o2.pct}%.` : ''}\n${PAY_LINE}`, [payBtn(lead, now)], { own: true }));
      else if (canPush(lead)) out.push(push(`⏳ ${o1.pct}% सूट 3 तासांत संपेल`, [{ id: 'push:OFFER', label: '💬 WhatsApp वर सूट' }]));
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
    if (canPush(lead) && !lead.paid) {   // owner 2026-11-14: no daily tests on WhatsApp — the app reminds
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
  const testOfferLine = lead => (ruleText(lead) ? '🎁 ' + ruleText(lead) : '📝 Demo test: 10 मिनिटं, login नाही.');
  // short (owner: as little text as possible): one line of what the course is, the price, the link
  const shortCourse = (lead, now) => `🔓 पूर्ण *${TS(lead)}*${unlockText(lead, now)}`;
  const courseButtons = [INFO, { id: 'fee', label: '💳 फी' }];
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
          if (o) { lead.courseAsked = true; out.push(wa(lead, now, `⏳ ${lead.name} साठी ${o.pct}% सूट ${whenText(o.end, now)} पर्यंत${priceText(lead, true, now) ? ' (' + priceText(lead, true, now) + ')' : ''}.\nपूर्ण ${TS(lead)}${lead.series && lead.series.short ? ': ' + lead.series.short : ''}\n${PAY_LINE}`, [payBtn(lead, now)], { own: true })); }
          return;
        }
        if (lead.awaiting === 'cls') out.push(wa(lead, now, '🙏 पाल्याची free test अजून बाकी आहे. कोणती Test Series? 👇', clsButtons(lead), { own: true }));
        else if (lead.awaiting === 'name') out.push(wa(lead, now, `🙏 ${lead.cls ? TS(lead) + ' ची ' : ''}free test अजून बाकी आहे (10 मिनिटं).\n${testOfferLine(lead)}\n✍️ पाल्याचं नाव लिहा — link लगेच पाठवतो 👇`, [], { own: true }));
        else (lead.courseAsked = true, out.push(wa(lead, now, `📝 ${lead.name === 'तुमचा पाल्य' ? 'पाल्याने' : lead.name + ' ने'} free test दिली का? फक्त 10 मिनिटं, login नाही 👇\n${L.child(lead.gid)}\n\n${testOfferLine(lead)}\n${shortCourse(lead, now)}`, [{ id: 'got', label: '👍 पाल्याला दिली' }, ...courseButtons], { own: true })));
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
      out.push(wa(lead, now, `🙏 ${who} ${TS(lead)} घ्यायची आहे का?${lead.testsDone ? '' : '\n' + testOfferLine(lead)}\nपुढच्या आठवणी हव्या असतील तर ✅ दाबा.${teamLine()}`, [{ id: 'keep', label: '✅ हो, आठवण हवी' }, ...courseButtons], { own: true }));
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

  return { CONFIG, L, createLead, inbound, welcome, teacherWelcome, teacherTeamStep, TSTEPS, event, tick, nextDue, isOpen, whenText, dayKey, atIST, priceText, offerNow, ruleText, cleanName, paidClaim, TS };
});
