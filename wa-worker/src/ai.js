// 🤖 A parent's own question (free text the rules do not know) answered by Google Gemini (free tier, owner's choice
// 2026-11-14) — only from the facts we give it; anything else goes to the team as before. Off unless AI_ON = "1".
//   aiAnswer(env, lead, question, now, WA) → { answer, handoff, model, ms } (handoff = the team answers)
// Safety: a number (₹ / count) or link in the answer that is not in the facts → handoff; at most AI_DAILY answers
// a family a day; a slow / failed call → handoff (the parent never waits long, nothing is lost).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const AI_MODEL_DEFAULT = 'gemini-flash-lite-latest';

export async function geminiModels(env) {
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || 'Gemini ' + r.status);
  return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
}

// the whole catalogue from Render (subjects, chapters, tests, prices, Admin's description), kept 6 h; Render asleep →
// the last copy, else the public class list
export let classErr = '';
export async function classList(env, S) {
  const kept = JSON.parse((await S.kvGet(env, 'ai:classes').catch(() => null)) || 'null');
  // the full catalogue is kept 6 h; the short public list (Render's key failed / asleep) only 10 min
  if (kept && Date.now() - kept.at < (kept.full ? 6 * 3600e3 : 600e3)) return kept.list;
  const base = env.RENDER_URL.replace(/\/$/, '');
  let list = null, full = false;
  try {
    const r = await fetch(`${base}/api/guest/bot/course-info`, { headers: { 'X-Bot-Key': env.SHARED_SECRET || '' }, signal: AbortSignal.timeout(6000) });
    if (r.ok) { list = (await r.json()).data || null; full = !!list; } else classErr = 'course-info HTTP ' + r.status;
  } catch (e) { classErr = 'course-info ' + e.message; }
  if (!list) {
    try {
      const r = await fetch(`${base}/api/guest/batches`, { signal: AbortSignal.timeout(5000) });
      list = ((await r.json()).data || []).map(b => ({ name: b.name, standard: b.standard, medium: b.medium, free_tests: b.free_tests || 0, subjects: (b.subjects || []).map(n => ({ name: n, chapters: [] })) }));
    } catch {}
  }
  if (!list) return kept ? kept.list : [];
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind('ai:classes', JSON.stringify({ at: Date.now(), list, full })).run().catch(() => {});
  return list;
}
const rs = n => '₹' + Number(n).toLocaleString('en-IN');
// one class, in full (its own family's class) or short (the others)
function classText(c, full) {
  const head = `${c.name}${c.medium ? ' · ' + c.medium : ''}${c.board ? ' · ' + c.board : ''}` +
    `${c.tests ? ' · एकूण ' + c.tests + ' tests' : ''}${c.free_tests ? ' · ' + c.free_tests + ' free tests' : ''}` +
    `${c.monthly ? ' · Monthly ' + rs(c.monthly) : ''}${c.yearly ? ' · Yearly ' + rs(c.yearly) : ''}`;
  if (!full) return head + (c.subjects.length ? ' · विषय: ' + c.subjects.map(sb => sb.name).join(', ') : '');
  return head + (c.about ? '\nमाहिती: ' + c.about : '') +
    c.subjects.map(sb => `\n- ${sb.name}${sb.chapters.length ? ': ' + sb.chapters.join(', ') : ''}`).join('') +
    (c.subjects.some(sb => sb.chapters.some(ch => ch.startsWith('🆓'))) ? '\n(🆓 = free chapter)' : '');
}

// what the AI may say — this family's own facts + the classes
export function facts(lead, now, WA, classes) {
  const L = WA.L, C = WA.CONFIG, o = lead.paid ? null : WA.offerNow(lead, now);
  const price = WA.priceText(lead, false, now), team = String(C.teamNumber || '').replace(/^91/, '');
  const mt = lead.mtNext ? WA.whenText(new Date(lead.mtNext), now) : '';
  return [
    `संस्था: NKs EduOrbit — विद्यार्थ्यांसाठी online tests / सराव app (Maharashtra State Board).`,
    `या पालकाच्या पाल्याचा class: ${lead.cls || 'अजून माहीत नाही'}. नाव: ${lead.name && lead.name !== 'तुमचा पाल्य' ? lead.name : 'माहीत नाही'}.`,
    `WhatsApp वर 1 demo test (login नाही, 10 मिनिटं) — ती सोडवली की course वर 50% सूट. पुढचा सराव app मध्ये (काही सराव tests app मध्ये मिळतात). पाल्याने आतापर्यंत दिलेल्या tests: ${lead.testsDone || 0}.`,
    lead.totalTests ? `पूर्ण course मध्ये एकूण ${lead.totalTests} tests.` : '',
    `पूर्ण course मध्ये: सगळ्या chapters चे tests, प्रत्येक प्रश्नाचं स्पष्टीकरण, notes, Exercise आणि सराव, दर रविवारी महा-Test, पालकांना progress report. Internet नसतानाही app चालतं.`,
    price ? `फी: ${price}. Monthly = 30 दिवस, Yearly = या शैक्षणिक वर्षाच्या 30 एप्रिलपर्यंत (दोन्ही 30 एप्रिलला संपतात). Payment UPI / Card / Net banking ने pay link वरून; pay केलं की लगेच app मध्ये course उघडतो.` : 'फी: pay page वर.',
    o ? `आत्ता पहिल्या payment वर ${o.pct}% सूट — ${WA.whenText(o.end, now)} पर्यंत.` : (lead.testsDone ? 'सध्या सूट चालू नाही.' : `Demo test सोडवली की 24 तास 50% सूट, नंतर रविवार रात्रीपर्यंत 30%.`),
    `WhatsApp वर फक्त 1 demo test; रोज WhatsApp वर tests पाठवत नाही. पुढचे सगळे tests आणि रोजची आठवण app मध्ये.`,
    `App: ${C.play} — Login → Student Code + PIN (हे आधी WhatsApp वर पाठवलेले असतात). PIN विसरला तर App › Login › "📲 WhatsApp ने login".`,
    mt ? `महा-Test: ${mt} — सगळ्या विद्यार्थ्यांमध्ये क्रमांक, मोफत, नोंदणी इथे "महा-Test नोंदणी" बटणाने.` : 'महा-Test: दर रविवारी.',
    `Links: free test ${L.child(lead.gid)} · course / pay ${L.pay(lead.gid)}`,
    team ? `Team चा नंबर (call / WhatsApp): ${team}.` : '',
    ...(() => {
      const mine = classes.find(c => c.name === lead.cls), others = classes.filter(c => c !== mine);
      return [
        mine ? `या पाल्याचा पूर्ण course (विषय आणि chapters):\n${classText(mine, true)}` : '',
        others.length ? `इतर उपलब्ध classes:\n${others.map(c => '- ' + classText(c, false)).join('\n')}` : '',
        classes.length ? 'यापेक्षा वेगळे classes / standards सध्या नाहीत.' : '',
      ];
    })(),
  ].filter(Boolean).join('\n');
}

const SYSTEM = `तू NKs EduOrbit चा WhatsApp सहाय्यक आहेस. पालकांच्या प्रश्नांना उत्तर देतोस.
नियम:
- उत्तर फक्त खालच्या FACTS मधूनच. FACTS मध्ये नसलेलं काहीही (किंमत, सूट, तारीख, वेळ, नंबर, link, विषय, वचन) कधीही स्वतः बनवू नको.
- सोपी मराठी (देवनागरी), 1 ते 3 छोटी वाक्यं, 60 शब्दांपेक्षा कमी, आदराने. पालक English / Hinglish मध्ये लिहिले तरी उत्तर मराठीत.
- Link फक्त FACTS मधली आणि गरज असेल तेव्हाच.
- handoff = true आणि answer रिकामं ठेव जर: उत्तर FACTS मध्ये नाही; पैसे कापले / payment अडकलं / refund / तक्रार; account, PIN किंवा device ची अडचण; पालक call मागतात किंवा रागावलेले आहेत; प्रश्न शिक्षण / NKs शी संबंधित नाही; तुला खात्री नाही.
- "धन्यवाद", "ok" सारख्या मेसेजला छोटं धन्यवाद पुरे.
- "free" / "फ्री" हा शब्द वापरू नको: "demo test" किंवा "सराव tests" म्हण. फक्त महा-Test "मोफत" म्हणता येईल. "सगळं मोफत आहे का" विचारलं तर: 1 demo test आणि महा-Test मोफत, पूर्ण course साठी फी.`;

export async function aiAnswer(env, lead, question, now, WA, classes, model) {
  const t0 = Date.now(), m = model || env.AI_MODEL || AI_MODEL_DEFAULT;
  const fx = facts(lead, now, WA, classes);
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + '\n\nFACTS:\n' + fx }] },
    contents: [{ role: 'user', parts: [{ text: String(question).slice(0, 500) }] }],
    generationConfig: {
      temperature: 0.2, maxOutputTokens: 1024, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' }, handoff: { type: 'BOOLEAN' } }, required: ['answer', 'handoff'] },
    },
  };
  try {
    const r = await fetch(`${BASE}/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || 8000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { handoff: true, answer: '', model: m, ms: Date.now() - t0, err: j.error?.message || 'HTTP ' + r.status };
    const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let out; try { out = JSON.parse(txt); } catch { return { handoff: true, answer: '', model: m, ms: Date.now() - t0, err: 'not JSON' }; }
    let answer = String(out.answer || '').trim().slice(0, 700), handoff = !!out.handoff || !answer;
    // a number or a link that is not in the facts: never send it
    const dig = answer.replace(/[०-९]/g, d => String('०१२३४५६७८९'.indexOf(d)));   // Marathi digits count too
    const bad = !handoff && ((dig.match(/\d[\d,]{1,}/g) || []).some(n => !fx.includes(n.replace(/,$/, ''))) || (answer.match(/https?:\/\/\S+/g) || []).some(u => !fx.includes(u.replace(/[).,]+$/, ''))));
    if (bad) return { handoff: true, answer, model: m, ms: Date.now() - t0, err: 'unknown number / link' };
    return { handoff, answer: handoff ? '' : answer, model: m, ms: Date.now() - t0 };
  } catch (e) { return { handoff: true, answer: '', model: m, ms: Date.now() - t0, err: e.message }; }
}
