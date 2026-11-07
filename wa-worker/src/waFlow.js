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
    earlyHours: 1,                // the daily test goes this much before the window closes, if the chosen time is later
    quiet: { from: 21, to: 8 },   // no message from the bot in these hours (IST)
    maxUnanswered: 4,             // bot's own messages in one window without a reply
    autoTemplates: false,         // false = the bot never pays for a message by itself: closed window → nothing,
                                  // the lead goes to the call list; only Admin sends a paid (template) message by hand
    missLimit: 2,                 // (only with autoTemplates) closed-window days without a reply → stop
    revisit: { month: 6, day: 1 },// a closed lead comes back in Admin on this date of the next year (June 1: new school year)
    reportEvery: 5,               // a short report + pay link after every N free tests
    hotAfterDays: 7,              // still taking tests but not paid after N days → hot call list
    dailyTimes: [{ id: '18', label: 'संध्याकाळी 6', h: 18 }, { id: '19', label: '7', h: 19 }, { id: '20', label: '8', h: 20 }],
    mahaTest: { dow: 0, h: 9, m: 30, remindH: 8, resultH: 12 },
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
    };
  }

  // ── sending ──
  const isOpen = (lead, now) => !!lead.lastInboundAt && now - new Date(lead.lastInboundAt) < CONFIG.windowHours * H;
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
    return { to: 'wa', kind, cost, text, buttons: buttons || [] };
  }
  const push = (text, buttons) => ({ to: 'push', text, buttons: buttons || [] });
  // a message the team sends by hand from its own WhatsApp (not the bot number): free; Admin opens wa.me with this text
  const team = (lead, text) => ({ to: 'team', cost: 0, text, waMe: `https://wa.me/91${lead.mobile || ''}?text=${encodeURIComponent(text)}` });
  const appMsg = (text, buttons) => ({ to: 'app', text, buttons: buttons || [] });
  const canPush = lead => lead.app && lead.pushOn;

  // ── texts ──
  const HINT = '\n👉 पुढची free test हवी तेव्हा फक्त *TEST* पाठवा.';
  const tail = lead => (lead.kind === 'regular' ? '\n👉 पुढचा free धडा हवा तेव्हा फक्त *TEST* पाठवा.' : HINT) +
    (lead.app ? '' : `\n\nहवं असल्यास app install करा आणि सर्व उपलब्ध free ${lead.kind === 'regular' ? 'धडे पाहा' : 'tests सोडवा'} 👇\n${CONFIG.play}`);
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
    out.push(wa(lead, now, `🎯 ${lead.name} चा पूर्ण result!\n${scoreLine(lead.last)}\n👇 result पाहा: ${L.result(lead.gid)}${unlockText(lead, now)}\n\n📲 मित्रांनाही free test पाठवा 👉 ${L.share(lead.gid)}` + tail(lead), unlockButtons(lead), { template: 'utility' }));
    if (!lead.daily) out.push(wa(lead, now, `📝 रोज 1 free test WhatsApp वर पाठवू? ${lead.cls ? lead.cls + ' चे ' : ''}${lead.freeTotal} free tests आहेत. कोणत्या वेळी?`,
      [...CONFIG.dailyTimes.map(t => ({ id: 'daily:' + t.id, label: t.label })), { id: 'daily:no', label: 'नको' }], { template: 'utility' }));
  }
  // one free test link (at most one a day on WhatsApp; Sunday is the महा-Test's day)
  function testLink(lead, now, out, own) {
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
    lead.testDay = dayKey(now);
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
    out.push(wa(lead, now, `${lead.name}, तुझी free test (10 मिनिटं, login नाही) 📝\n👇\n${L.child(lead.gid)}`));
  }
  function shareMsg(lead, now, out) {
    lead.shared = true;
    const prizes = CONFIG.prizes.map(p => `${p[0]} मित्र = ${p[1]}`).join(' · ');
    out.push(wa(lead, now, `🎓 NKs EduOrbit वरचे courses:\n${lead.courses.join(' · ')}\n\n📲 ओळखीच्या विद्यार्थ्यांना ही link पाठवा 👇\n${L.share(lead.gid)}\n\n🎁 तुमच्या link वरून आलेल्या मित्रांनी pay केलं ${lead.paid ? 'की' : 'आणि तुम्ही pay केलं की'} ते ${lead.name} च्या Refer & Earn मध्ये मोजले जातात: ${prizes}.\nनियम 👉 ${L.rules(lead.gid)}` + HINT,
      [{ id: 'share_done', label: '📲 Share केलं' }, { id: 'rules', label: '📄 नियम पाहा' }]));
    out.push(log('SHARE', 'Courses + share link: दुसऱ्या test नंतर, पालकांच्या reply ला उत्तर म्हणून (मोफत). यादी Admin मधल्या classes मधून.'));
  }
  function offerMsg(lead, now, out) {
    if (lead.paid) { out.push(wa(lead, now, `✅ ${lead.name} चं account आधीच चालू आहे.`)); return; }
    const o = offerNow(lead, now);
    out.push(wa(lead, now, `${o ? `🎁 पहिल्या payment वर ${o.pct}% सूट — ${whenText(o.end, now)} पर्यंत.${priceText(lead, true, now) ? '\n' + priceText(lead, true, now) : ''}` : '📚 सगळे chapters, tests, notes आणि महा-Test'}\n👇 ${L.pay(lead.gid)}`,
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

  // ── the parent's message (or a button tap) ──
  function inbound(lead, raw, now) {
    const out = [];
    const t = String(raw || '').trim();
    const up = t.toUpperCase();
    lead.lastInboundAt = now.toISOString(); lead.unanswered = 0; lead.miss = 0;
    if (lead.closed && lead.closed !== 'STOP' && up !== 'STOP') { out.push(log('CRM', `Closed lead (${lead.closed}) ने स्वतः मेसेज केला → पुन्हा उघडला, प्रवास पुन्हा सुरू.`)); lead.closed = null; lead.stopped = false; lead.crm = null; lead.revisitAt = null; }
    else if (lead.stopped && lead.closed !== 'STOP' && up !== 'STOP') { out.push(log('RESUME', 'Reply आला → call यादीतून बाहेर, रोजचा प्रवास पुन्हा सुरू.')); lead.stopped = false; if (lead.crm === 'cold' || lead.crm === 'form') lead.crm = null; }
    if (lead.crm === 'form' && up !== 'STOP') { lead.crm = null; out.push(log('RESUME', 'Form ने नंबर दिलेल्या पालकांनी reply दिला → WhatsApp प्रवास सुरू.')); }
    if (up === 'STOP') { lead.closed = 'STOP'; lead.stopped = true; out.push({ to: 'wa', kind: 'service', cost: 0, text: '🙏 ठीक आहे, आता मेसेज बंद. पुन्हा हवं असेल तर START पाठवा.', buttons: [] }); return out; }
    if (up === 'START' && lead.closed === 'STOP') { lead.closed = null; lead.stopped = false; out.push(wa(lead, now, '🙏 परत स्वागत!', mainButtons(lead, now))); return out; }
    const kw = up.split(/\s+/)[0];
    if (lead.awaiting === 'name' && !/^[A-Z_]+:/.test(up) && !['TEST', 'STOP'].includes(kw)) {
      lead.awaiting = null; lead.name = t.replace(/^name:/i, '').slice(0, 30); out.push({ to: 'do', action: 'name', name: lead.name });
      childLinkMsgs(lead, now, out);
      out.push(log('CRM', `पाल्याचं नाव ${lead.name}. Test ची वाट; दिली की result इथे.`));
      return out;
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
      if (!lead.daily && !lead.paid && !lead.app) out.push(wa(lead, now, lead.kind === 'regular' ? '📚 असा रोज 1 free धडा पाठवू? कोणत्या वेळी?' : '📝 अशी रोज 1 free test पाठवू? कोणत्या वेळी?', [...CONFIG.dailyTimes.map(x => ({ id: 'daily:' + x.id, label: x.label })), { id: 'daily:no', label: 'नको' }])); out.push(log(kw === 'PUSH' ? 'PUSH' : 'TEST', kw === 'PUSH' ? 'Push चं 💬 WhatsApp बटण → खिडकी 24 तास.' : 'पालकाने स्वतः TEST मागितलं → मोफत, खिडकी 24 तास.')); return out; }
    if (kw === 'MAHA' || t === 'mt_want') {
      // the window is open now (they wrote): the result and the rank come here as soon as the महा-Test closes
      if (!lead.via) { out.push({ to: 'do', action: 'lead' }); lead.via = 'wa'; }
      lead.mtWant = true;
      out.push(wa(lead, now, kw === 'MAHA'
        ? `🏆 ${lead.name} चा महा-Test जमा झाला ✅\nसगळ्यांचा test संपला की गुण, क्रमांक आणि Top 10 इथेच पाठवतो.`
        : `✅ ठीक आहे! उद्या महा-Test नंतर ${lead.name} चे गुण आणि क्रमांक इथेच येतील.`, [{ id: 'got', label: '👍 ठीक' }]));
      out.push(log('MT', kw === 'MAHA' ? 'महा-Test नंतर website वरून WhatsApp → खिडकी उघडी, result इथे.' : 'शनिवारी "result WhatsApp वर हवा? ✅" → खिडकी रविवारपर्यंत उघडी.'));
      return out;
    }
    if (kw === 'HELP') { out.push(wa(lead, now, 'नमस्कार 🙏 काय मदत हवी?', [{ id: 'ask:pin', label: 'PIN विसरलो' }, { id: 'ask:open', label: 'Test उघडत नाही' }, { id: 'ask:fee', label: 'फी किती?' }])); return out; }
    if (kw === 'OFFER' || t === 'pay') { offerMsg(lead, now, out); return out; }
    if (kw === 'MAHATEST' || t === 'mt_reg') {
      if (lead.mtReg) out.push(wa(lead, now, `✅ ${lead.name} ची नोंदणी आधीच झाली आहे. ${mtLeft(now, lead)}.`));
      else { lead.mtReg = true; out.push({ to: 'do', action: 'mt_register' }); out.push(wa(lead, now, `✅ ${lead.name} ची ${whenText(nextMahaTest(now, lead) || now, now)} च्या महा-Test साठी नोंदणी झाली.\n50 प्रश्न · 60 मिनिटं · लगेच गुण आणि क्रमांक.`)); out.push(log('CRM', 'महा-Test नोंदणी (WeeklyEntry).')); }
      return out;
    }
    if (kw === 'REPORT') { out.push(wa(lead, now, `📊 ${lead.name}: ${lead.testsDone} tests${lead.last ? `, शेवटचा ${lead.last.score}/${lead.last.total}` : ''}.\nकमकुवत: ${lead.last?.weak || '—'}\nसगळे chapters 👇 ${L.pay(lead.gid)}` + HINT, [{ id: 'ask', label: '❓ प्रश्न' }])); return out; }
    if (kw === 'LOGIN') { out.push(wa(lead, now, `✅ हा नंबर ${lead.name} च्या account चा आहे. App मध्ये परत जा — login झाला. ${lead.paid ? 'PIN ठेवा 🔑' : ''}`)); out.push(log('LOGIN', 'Code एकदाच, 5 मिनिटं, त्याच phone साठी; नोंदवलेल्या नंबरवरूनच.')); return out; }
    if (t.startsWith('daily:')) {
      const id = t.slice(6), c = CONFIG.dailyTimes.find(x => x.id === id);
      lead.daily = c ? id : 'no';
      out.push(wa(lead, now, c ? `✅ रोज ${c.h - 12} वाजता ${lead.name} ची पुढची free test येईल. ${mtLeft(now, lead)}.\nमेसेज नको असतील तर कधीही STOP पाठवा.` : '🙏 ठीक आहे. महा-Test ची आठवण मात्र देऊ.\nमेसेज नको असतील तर कधीही STOP पाठवा.'));
      out.push(log('CRM', c ? `रोजची free test: ${c.h - 12} वाजता (रविवारी महा-Test).` : 'रोजची test नको → फक्त महा-Test.'));
      return out;
    }
    if (t === 'app') { out.push(wa(lead, now, `हे घ्या 👇\n${CONFIG.play}\nInstall केल्यावर login लागत नाही. ${lead.name} चे गुण app मध्ये आपोआप दिसतील.`)); return out; }
    if (t === 'got') { out.push(wa(lead, now, '👍 Test झाली की result इथे येईल.')); return out; }
    if (t === 'next') { out.push(wa(lead, now, '👍 उद्या पुढची पाठवतो.')); if (!lead.shared && lead.testsDone >= 2) shareMsg(lead, now, out); return out; }
    if (t === 'ask') { out.push(wa(lead, now, 'कोणता प्रश्न?', [{ id: 'ask:fee', label: 'फी किती?' }, { id: 'ask:app', label: 'App कसा वापरायचा?' }])); return out; }
    if (t === 'ask:fee') { answer(lead, now, out, `${priceText(lead, false, now) || 'फी: pay page वर'}.${offerLine(lead, now)}\nPay नंतर सगळे tests, notes, स्वाध्याय उत्तरं आणि महा-Test.`); return out; }
    if (t === 'ask:app') { answer(lead, now, out, 'Play Store वरून install करा → login लागत नाही → Home वर "पुढचा test". Pay नंतर Student Code + PIN किंवा WhatsApp login.'); return out; }
    if (t === 'ask:pin') { answer(lead, now, out, 'App → Login → "📲 WhatsApp ने login" → नवीन PIN. 1 मिनिट.'); return out; }
    if (t === 'ask:open') { answer(lead, now, out, 'App update करा (Play Store) आणि internet चालू ठेवून एकदा उघडा.'); return out; }
    if (t === 'ok') { out.push(wa(lead, now, 'धन्यवाद 🙏', mainButtons(lead, now))); return out; }
    if (t === 'more' || t === 'call_me') { lead.crm = 'call'; out.push(wa(lead, now, '🙏 धन्यवाद! आमची team तुम्हाला लवकरच call करेल.')); out.push(log('CALL', '📞 Call request → Admin › CRM "Call करायचे" (वरती) + लाल संख्या.')); return out; }
    if (t === 'share_done') { out.push(wa(lead, now, '🙏 धन्यवाद! मित्रांनी pay केलं की तुमच्या Refer & Earn मध्ये दिसेल 👉 ' + L.rules(lead.gid))); out.push(log('SHARE', `मित्र आला की "कोणाकडून" नोंद (ref=${lead.gid}). Free असताना मित्र राखून ठेवले जातात; pay केल्यावर मोजले जातात.`)); return out; }
    if (t === 'rules') { out.push(wa(lead, now, `📄 ${L.rules(lead.gid)}\nमित्राने pay केलं तरच मोजला जातो · pay नंतर 7 दिवसांनी पक्का · तुम्ही free असताना आलेले मित्र तुम्ही pay केल्यावर मोजले जातात · तुमच्याच नंबरवरून नाही · बक्षिसासाठी पालकांची संमती + पत्ता.`)); return out; }
    if (/^q:[A-D]$/.test(t)) { const okA = t === 'q:B'; out.push(wa(lead, now, (okA ? '✅ बरोबर! फरक 4, 6, 8, 10 → 30.' : 'थोडं चुकलं 🙂 फरक 4, 6, 8 → पुढचा 10 → 30 (B).') + offerLine(lead, now), mainButtons(lead, now))); return out; }
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
          (done && !lead.paid ? `\n\n🎉 सगळे ${lead.freeTotal} free tests पूर्ण!` : '') + unlockText(lead, now), b, { template: 'utility' }));   // real activity: not counted in maxUnanswered
      }
      if (report) out.push(log('REPORT', `दर ${CONFIG.reportEvery} tests नंतर रिपोर्ट + pay link (रोज offer नाही).`));
      if (done && !lead.paid && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', '🔥 सगळे free tests पूर्ण, pay नाही → गरम call यादी.')); }
      return out;
    }
    if (type === 'sync') {
      // fresh facts from the server (name, class, free tests, courses, prices, next महा-Test, paid, app…); no message
      for (const k of ['name', 'cls', 'freeTotal', 'totalTests', 'kind', 'freeLessons', 'courses', 'prices', 'mtNext', 'mtReg', 'paid', 'app', 'pushOn', 'mobile', 'testsDone']) if (data[k] !== undefined && data[k] !== null) lead[k] = data[k];
      if (data.firstTestAt && !lead.firstTestAt) { lead.firstTestAt = data.firstTestAt; lead.offerEnd = data.offerEnd || new Date(new Date(data.firstTestAt).getTime() + CONFIG.offerHours * H).toISOString(); }
      if (data.last) lead.last = data.last;
      if (lead.paid && lead.crm !== 'paid') lead.crm = 'paid';
      return out;
    }
    if (type === 'mt_result') { mtResult(lead, now, out, data); return out; }
    if (type === 'form_number') {
      // typed the number on the website (no WhatsApp message from them): the bot sends nothing (it would cost);
      // the lead waits in the call list, where Admin can call or send one WhatsApp by hand
      lead.via = 'form'; lead.crm = 'form';
      out.push(log('FORM', 'Form वरून नंबर (संमतीची खूण). खिडकी उघडी नाही → bot काही पाठवत नाही. 📞 call यादी: call करा किंवा Admin मधून हाताने WhatsApp.'));
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
      out.push(wa(lead, now, `🎉 ${lead.name} चं account तयार!\n👤 Student Code: ${data.code || '—'}\n🔑 PIN: तुम्ही ठेवलेला\n📱 App 👇 ${CONFIG.play}\nकिंवा "📲 WhatsApp ने login" — code टाइप करावा लागत नाही.`, [], { template: 'utility' }));
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
    if (!lead.firstTestAt || lead.closed === 'STOP') return items;
    const first = new Date(lead.firstTestAt), offerEnd = new Date(lead.offerEnd);
    const hasWa = !!lead.lastInboundAt;
    // 1) pay nudges inside the offer (never as paid templates)
    const nudge = (key, at, fn) => { if (!lead.paid && !quiet(at) && at < offerEnd) items.push({ key, at, run: fn }); };
    nudge('nudge1', new Date(first.getTime() + H), (out, now) => {
      if (lead.lastInboundAt && now - new Date(lead.lastInboundAt) < 0.8 * H) return;   // just talked
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
    // 2) the daily free test, from the day after the first test, not on Sunday
    const choice = CONFIG.dailyTimes.find(x => x.id === lead.daily);
    if ((choice || canPush(lead)) && !lead.paid) {
      for (let d = 1; d <= 21; d++) {
        const base = atIST(first, choice ? choice.h : 19, 0, d);
        if (isMtDay(base, lead)) continue;
        let at = base;
        // the window would close before the chosen time: go a little before it closes
        if (!canPush(lead) && lead.lastInboundAt) {
          const early = new Date(new Date(lead.lastInboundAt).getTime() + (CONFIG.windowHours - CONFIG.earlyHours) * H);
          if (early < base && dayKey(early) === dayKey(base) && !quiet(early)) at = early;   // the same day, from 8 am
        }
        items.push({ key: 'daily:' + dayKey(base), at, run: (out, now) => {
          if (lead.kind === 'regular' ? lead.freeLessons && lead.lessonsSent >= lead.freeLessons : lead.testsDone >= lead.freeTotal) return;
          if (lead.closed) { if (canPush(lead)) out.push(push('आजची free test तयार 📝')); return; }
          if (lead.testDay === dayKey(now)) return;
          if (canPush(lead)) { out.push(push(`${lead.name}, आजची free test (${lead.testsDone + 1}/${lead.freeTotal}) · ${mtLeft(now, lead)}`, [{ id: 'app:open', label: '📱 App उघडा' }, { id: 'push:PUSH', label: '💬 WhatsApp वर link' }])); return; }
          if (lead.stopped || !hasWa) return;
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
    // 4) a week on, still free and still taking tests → hot list
    items.push({ key: 'hot', at: new Date(first.getTime() + CONFIG.hotAfterDays * 24 * H), run: (out) => {
      if (!lead.paid && !lead.closed && !lead.stopped && !lead.crm) { lead.crm = 'hot'; out.push(log('CRM', `🔥 ${CONFIG.hotAfterDays} दिवस, tests चालू, pay नाही → गरम call यादी.`)); }
    } });
    return items;
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

  return { CONFIG, L, createLead, inbound, event, tick, nextDue, isOpen, whenText, dayKey, atIST, priceText };
});
