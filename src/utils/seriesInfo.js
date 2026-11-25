// "Test Series" facts for parents — ONE source for the WhatsApp bot, the pay page and the app's course details
// (owner 2026-11-25: parents see "Test Series", never "class" / "course"; competitive exams have no notes;
// every number comes from Admin's own data — a fact that is not there is simply left out).
//
//   seriesInfo(batchName) → { name, raw, kind, lines: [..], short, prices, tests, years, daily, weekly }
//   cleanName('8th NMMS EXAM 26-27 BATCH') → '8वी NMMS'
const Batch = require('../models/Batch');
const Quiz = require('../models/Quiz');
const WeeklySchedule = require('../models/WeeklySchedule');
const { kindOf } = require('./courseKind');

// "8th NMMS EXAM 26-27 BATCH" → "8वी NMMS"; "10th - Semi English" → "10वी - Semi English"
const ORD = { 1: '1ली', 2: '2री', 3: '3री', 4: '4थी' };
function cleanName(name) {
  let s = String(name || '').replace(/\b(batch|exam|class)\b/gi, ' ').replace(/\b\d{2,4}\s*[-–]\s*\d{2,4}\b/g, ' ');
  s = s.replace(/\b(\d{1,2})\s*(st|nd|rd|th)\b/gi, (_, n) => ORD[n] || `${n}वी`);
  s = s.replace(/\s*\(\s*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([-–])\s*$/, '').trim();
  return s || String(name || '').trim();
}
const DOW = ['रवि', 'सोम', 'मंगळ', 'बुध', 'गुरु', 'शुक्र', 'शनि'];
const part = h => (h < 12 ? 'सकाळी' : h < 17 ? 'दुपारी' : h < 21 ? 'संध्याकाळी' : 'रात्री');
function timeText(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${part(h)} ${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}
// [1,2,3,4,5,6] → "सोम–शनि"; [0..6] → "रोज"; [1,3,5] → "सोम, बुध, शुक्र"
function daysText(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'रोज';
  const run = d.length > 2 && d.every((x, i) => !i || x === d[i - 1] + 1);
  return run ? `${DOW[d[0]]}–${DOW[d[d.length - 1]]}` : d.map(x => DOW[x]).join(', ');
}
const marksOf = p => Math.round((p?.parts || []).reduce((a, x) => a + (x.count || 0) * (x.marks || 1), 0) * 100) / 100;
const PAPER_RX = /previous|paper|pyq|प्रश्नपत्रिका|मागील|मागच्या|सराव पेपर/i;

const _cache = new Map();   // batch → { at, v }
async function seriesInfo(batchName) {
  const key = String(batchName || '');
  if (!key) return null;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const b = await Batch.findOne({ name: key }, 'name public_name kind standard medium description monthly_price yearly_price subjects.name subjects.chapters.name').lean();
  if (!b) return null;
  const kind = kindOf(b);
  const [titles, scheds] = await Promise.all([
    Quiz.find({ batch: key, status: 'published' }, 'title subject chapter').lean().catch(() => []),
    WeeklySchedule.find({ batch: key, enabled: true }).lean().catch(() => []),
  ]);
  // previous years' papers: years in the names of paper subjects / chapters / tests (2015 … this year)
  const thisYear = new Date().getFullYear(), years = new Set();
  const yearsIn = t => (String(t || '').match(/\b20[12]\d\b/g) || []).map(Number).filter(y => y >= 2015 && y <= thisYear);
  for (const s of b.subjects || []) for (const c of s.chapters || []) if (PAPER_RX.test(s.name) || PAPER_RX.test(c.name)) yearsIn(c.name).forEach(y => years.add(y));
  for (const q of titles) if (PAPER_RX.test(`${q.subject} ${q.chapter} ${q.title}`)) yearsIn(`${q.chapter} ${q.title}`).forEach(y => years.add(y));
  const yrs = [...years].sort();
  // the daily Paper Practice: each paper's time, days and marks
  const daily = [];
  for (const s of scheds.filter(x => x.kind === 'daily')) {
    const byKey = new Map();
    for (const sl of s.slots || []) {
      const k = `${sl.paper}|${sl.time}`;
      if (!byKey.has(k)) byKey.set(k, { paper: sl.paper, time: sl.time, days: [] });
      byKey.get(k).days.push(sl.dow);
    }
    for (const x of byKey.values()) daily.push({ ...x, marks: marksOf((s.papers || []).find(p => p.name === x.paper)) });
  }
  daily.sort((x, y) => x.time.localeCompare(y.time));
  // the महा-Test
  const w = scheds.find(x => x.kind !== 'daily');
  const weekly = w ? { day: w.day_of_week, time: w.start_time, marks: w.mode === 'papers' ? (w.papers || []).reduce((a, p) => a + marksOf(p), 0) : (w.question_count || 0) } : null;
  const subjects = (b.subjects || []).map(s => s.name).filter(n => !PAPER_RX.test(n) && !/practice|सराव|आकृती/i.test(n)).slice(0, 8);
  const name = String(b.public_name || '').trim() || cleanName(b.name);
  const rs = n => '₹' + Number(n).toLocaleString('en-IN');
  const price = [b.monthly_price ? `${rs(b.monthly_price)}/महिना` : '', b.yearly_price ? `${rs(b.yearly_price)} वर्षभर (30 एप्रिलपर्यंत)` : ''].filter(Boolean).join(' · ');
  const lines = [];
  if (kind === 'exam') {
    if (yrs.length) lines.push(`📄 ${yrs[0]} पासूनचे मागचे पेपर (${yrs.join(', ')}) — test म्हणून सोडवता येतात`);
    lines.push('🧠 मागच्या पेपरचा अभ्यास करून त्याच pattern चे नवीन प्रश्न · प्रत्येक प्रश्नाचं स्पष्टीकरण');
    if (daily.length) lines.push('⏰ ' + daily.map(x => `${daysText(x.days)} ${timeText(x.time)} ${x.paper}${x.marks ? ` (${x.marks} गुण)` : ''}`).join(' · '));
  } else {
    lines.push('📒 सगळ्या विषयांचे धडे: Notes · स्वाध्याय उत्तरं · सराव tests');
    if (daily.length) lines.push('⏰ ' + daily.map(x => `${daysText(x.days)} ${timeText(x.time)} ${x.paper}${x.marks ? ` (${x.marks} गुण)` : ''}`).join(' · '));
  }
  if (weekly) lines.push(`🏆 दर ${DOW[weekly.day]}वारी ${timeText(weekly.time)} महा-Test${weekly.marks ? ` (${weekly.marks} गुण)` : ''} — सगळ्यांमध्ये rank`);
  const tests = titles.length;
  if (tests || subjects.length) lines.push(`📚 ${tests ? tests + ' tests' : ''}${tests && subjects.length ? ' · ' : ''}${subjects.length ? 'विषय: ' + subjects.join(', ') : ''}`);
  lines.push('🧑‍🏫 Digital Teacher — रोज काय अभ्यास करायचा ते सांगतो');
  lines.push('📊 Me → Analytics — कमकुवत chapters आणि progress');
  lines.push('🔔 Notifications — test, महा-Test आणि result ची आठवण');
  lines.push('📥 Internet नसतानाही app मध्ये अभ्यास');
  if (price) lines.push('💳 ' + price);
  const v = {
    name, raw: b.name, kind, lines, price, tests, years: yrs, daily, weekly, subjects,
    about: String(b.description || '').slice(0, 400),
    // one line for short messages
    short: kind === 'exam'
      ? `${yrs.length ? yrs[0] + ' पासूनचे पेपर · ' : ''}pattern नुसार प्रश्न + स्पष्टीकरण${daily.length ? ' · रोज test' : ''}${weekly ? ' · महा-Test' : ''}`
      : `Notes · स्वाध्याय उत्तरं · सराव${weekly ? ' · महा-Test' : ''}`,
  };
  _cache.set(key, { at: Date.now(), v });
  return v;
}

module.exports = { seriesInfo, cleanName, _clear: () => _cache.clear() };
