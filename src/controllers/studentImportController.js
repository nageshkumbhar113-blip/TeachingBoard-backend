// Admin › Students › 📥 Import — create (or update) many student accounts at once.
//
// Owner's rules (Nov 2026):
//  • code = first 3 letters of the name + last 4 mobile digits (MAN4589), PIN = last 4 digits.
//  • course(s) + plan: monthly (30 days) or yearly (till 30 April); expiry is auto, admin may edit.
//  • the money was collected offline by the admin → one PAID subscription per course
//    (source 'admin_bulk'), so revenue, the teacher's paid students and commission all work as
//    for an online payment. Price = the course's monthly / yearly price, minus the teacher's
//    bulk discount (editable per import). Commission = the teacher's own commission rules.
//  • a student already on the platform (same mobile + same first 3 letters) is UPDATED, never
//    duplicated: courses added, expiry only moved later, code and PIN unchanged.
//  • the teacher (teacher code) gets the students, Paper Builder unlimited for those courses
//    until the students' expiry (30 April) — the teacher account's own validity is never
//    touched — and must accept the rules (utils/teacherRules.js).
//  • the same import sent twice never records money or commission twice (import_id keys).

const { randomUUID } = require('crypto');
const User = require('../models/User');
const Batch = require('../models/Batch');
const StudentSubscription = require('../models/StudentSubscription');
const CommissionEntry = require('../models/CommissionEntry');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidMobile } = require('../utils/mobile');
const { isWeakPin } = require('../utils/pin');
const { uniqueStudentCode, pinFromMobile, namePrefix } = require('../utils/studentCode');
const { findPartnerForStudent, commissionFor, recordCommissionForPayment } = require('../utils/partnerCommission');
const { RULES_VERSION, RULES_URL, rulesPending } = require('../utils/teacherRules');
const { invalidateUserCache } = require('../middleware/auth');
const { sendToUser } = require('../utils/fcm');

const MAX_ROWS = 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const PLANS = ['monthly', 'yearly', 'custom'];

const round2 = n => Math.round(Number(n) * 100) / 100;
const istDay = d => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);

// Expiry for a plan, as an IST calendar day 'YYYY-MM-DD' (monthly: +30 days, yearly: 30 April;
// neither ever past the next 30 April — StudentSubscription.computeExpiry).
function planExpiryDay(plan, now = new Date()) {
  return istDay(StudentSubscription.computeExpiry(plan === 'monthly' ? 'monthly' : 'yearly', now));
}

function parseDay(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || s.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (!m) return null;
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const iso = `${y}-${mo}-${d}`;
  return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? null : iso;
}

function splitCourses(value) {
  if (Array.isArray(value)) return value.map(s => String(s || '').trim()).filter(Boolean);
  return String(value || '').split(/[;|\n]/).map(s => s.trim()).filter(Boolean);
}

function cleanMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const dayStart = day => new Date(`${day}T00:00:00.000Z`);          // how User.expiry_date stores a day
const dayEndIst = day => new Date(`${day}T23:59:59.000+05:30`);   // last moment of that day in India

/** Split `total` over the courses in proportion to their list prices (paise-exact). */
function splitAmount(total, prices) {
  const sum = prices.reduce((a, b) => a + b, 0);
  if (!prices.length) return [];
  if (sum <= 0) return prices.map((_, i) => (i === 0 ? round2(total) : 0));
  let left = round2(total);
  return prices.map((p, i) => {
    if (i === prices.length - 1) return round2(left);
    const part = round2((total * p) / sum);
    left = round2(left - part);
    return part;
  });
}

/**
 * Work out every row: validation, code/PIN, existing student, courses, expiry, money and the
 * commission the teacher will get. Nothing is written here.
 */
async function planImport(body, now = new Date()) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new AppError('No students in the list', 400);
  if (rows.length > MAX_ROWS) throw new AppError(`At most ${MAX_ROWS} students per import`, 400);
  const d = body.defaults || {};
  const defaultPlan = PLANS.includes(d.plan) ? d.plan : 'yearly';
  const defaultExpiry = parseDay(d.expiry);
  if (defaultExpiry === null) throw new AppError('Invalid expiry date', 400);
  if (defaultPlan === 'custom' && !defaultExpiry) throw new AppError('Choose the expiry date for a custom plan', 400);
  const defaultCourses = splitCourses(d.batches);
  const discountOverride = d.discount_percent === '' || d.discount_percent == null ? null : Number(d.discount_percent);
  if (discountOverride !== null && (!Number.isFinite(discountOverride) || discountOverride < 0 || discountOverride > 100)) {
    throw new AppError('Discount must be 0–100 %', 400);
  }

  const batches = await Batch.find({}, 'name monthly_price yearly_price is_active').lean();
  const batchByName = new Map(batches.map(b => [b.name.trim().toLowerCase(), b]));

  // Teachers used in this import
  const teacherCodes = new Set([String(d.teacher_code || '').trim().toUpperCase(), ...rows.map(r => String(r.teacher_code || '').trim().toUpperCase())].filter(Boolean));
  const teachers = await User.find({ role: 'teacher', teacher_code: { $in: [...teacherCodes] } }).lean();
  const teacherByCode = new Map(teachers.map(t => [t.teacher_code, t]));
  if (d.teacher_code && !teacherByCode.has(String(d.teacher_code).trim().toUpperCase())) {
    throw new AppError(`Teacher code ${String(d.teacher_code).trim().toUpperCase()} not found`, 400);
  }

  // Students already on the platform with these mobiles
  const mobiles = [...new Set(rows.map(r => cleanMobile(r.mobile)).filter(m => m.length === 10))];
  const existing = await User.find({ role: 'student', mobile: { $in: mobiles } }).lean();

  const codesGiven = new Set();
  const seenInFile = new Set();
  const isTaken = async code => codesGiven.has(code) || !!(await User.exists({ student_code: code }));
  const out = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const line = i + 1;
    const name = String(r.name || '').replace(/\s+/g, ' ').trim();
    const mobile = cleanMobile(r.mobile);
    const errors = [];
    const warnings = [];
    if (!name) errors.push('नाव नाही');
    if (!isValidMobile(mobile)) errors.push('Mobile 10 अंकी नाही');

    const plan = PLANS.includes(String(r.plan || '').toLowerCase()) ? String(r.plan).toLowerCase() : defaultPlan;
    const rowExpiry = parseDay(r.expiry);
    if (rowExpiry === null) errors.push('Expiry तारीख चुकीची');
    let expiry = rowExpiry || (plan === 'custom' ? defaultExpiry : (defaultExpiry || planExpiryDay(plan, now)));
    if (!expiry) errors.push('Expiry तारीख नाही');
    else if (expiry < istDay(now)) errors.push('Expiry तारीख आधीच गेली');

    const courseNames = splitCourses(r.courses).length ? splitCourses(r.courses) : defaultCourses;
    const courses = [];
    for (const cname of courseNames) {
      const b = batchByName.get(cname.toLowerCase());
      if (!b) errors.push(`Course सापडला नाही: ${cname}`);
      else if (!courses.some(c => c.name === b.name)) courses.push(b);
    }
    if (!courseNames.length) errors.push('Course निवडलेला नाही');

    const tCode = String(r.teacher_code || d.teacher_code || '').trim().toUpperCase();
    const teacher = tCode ? teacherByCode.get(tCode) : null;
    if (tCode && !teacher) errors.push(`Teacher code सापडला नाही: ${tCode}`);
    if (teacher && (teacher.status || 'active') !== 'active') errors.push(`Teacher ${tCode} active नाही`);

    // Same student twice in the file
    const fileKey = `${mobile}:${namePrefix(name)}`;
    if (mobile && name && seenInFile.has(fileKey)) errors.push('याच file मध्ये आधी आला आहे');
    seenInFile.add(fileKey);

    // Existing student = same mobile and the same first 3 letters (siblings share a phone)
    const match = existing.find(s => s.mobile === mobile && namePrefix(s.name) === namePrefix(name)) || null;

    // Money
    const pricePeriod = plan === 'monthly' ? 'monthly' : 'yearly';
    const listPrices = courses.map(b => Number(pricePeriod === 'monthly' ? b.monthly_price : b.yearly_price) || 0);
    const listTotal = round2(listPrices.reduce((a, b) => a + b, 0));
    // owner 2026-11-19: the teacher's old "bulk discount %" is no longer used (only the admin's own per-import value)
    const discountPercent = discountOverride !== null ? discountOverride : 0;
    let netTotal = round2(listTotal * (1 - discountPercent / 100));
    const amountOverride = r.amount === '' || r.amount == null ? null : Number(r.amount);
    if (amountOverride !== null) {
      if (!Number.isFinite(amountOverride) || amountOverride < 0) errors.push('रक्कम चुकीची');
      else netTotal = round2(amountOverride);
    }
    if (!errors.length && listTotal === 0 && amountOverride === null) warnings.push('या course ची किंमत ₹0 आहे');

    let code = match?.student_code || '';
    let pin = '';
    if (!errors.length && !match) {
      code = await uniqueStudentCode(name, mobile, isTaken);
      pin = pinFromMobile(mobile);
      if (isWeakPin(pin)) warnings.push('PIN सोपा आहे (mobile चे शेवटचे अंक)');
    }
    if (code) codesGiven.add(code);
    if (match && match.status === 'blocked') warnings.push('हा विद्यार्थी blocked आहे — तसाच राहील');

    // Commission the teacher (partner) will get, as recordCommissionForPayment will compute it
    let commission = 0;
    let commissionTo = '';
    let commissionNote = '';
    if (!errors.length && netTotal > 0) {
      const studentForPartner = match
        ? { ...match, referred_by_teacher: match.referred_by_teacher || tCode }
        : { student_code: code, mobile, referred_by_teacher: tCode };
      const partner = (tCode || match?.referred_by_teacher) ? await findPartnerForStudent(studentForPartner) : null;
      if (partner) {
        let renewal = false;
        let skip = false;
        if (partner.commission_first_payment_only !== false && match) {
          const earlier = await CommissionEntry.exists({ partner_user_id: partner.user_id, student_code: match.student_code, type: 'commission', status: 'active' });
          if (earlier) {
            if (partner.commission_mode !== 'percent' || !(Number(partner.commission_renewal_value) > 0)) skip = true;
            else renewal = true;
          }
        }
        commission = skip ? 0 : commissionFor(partner, netTotal, renewal);
        commissionTo = partner.teacher_code || '';
        if (skip) commissionNote = 'पहिल्या payment नंतर commission नाही';
        else if (renewal) commissionNote = 'renewal %';
        if (match && match.referred_by_teacher && match.referred_by_teacher !== tCode) commissionNote = `commission आधीच्या teacher ${match.referred_by_teacher} ला`;
      } else if (teacher) {
        commissionNote = 'या teacher चे commission बंद';
      }
    }

    out.push({
      line, name, mobile, school: String(r.school || '').trim().slice(0, 120),
      action: errors.length ? 'error' : (match ? 'update' : 'create'),
      errors, warnings,
      student_code: code, pin, existing_id: match?.user_id || '',
      courses: courses.map(b => b.name), plan, expiry,
      list_prices: listPrices, list_total: listTotal, discount_percent: discountPercent,
      amount: netTotal, amounts: splitAmount(netTotal, listPrices),
      teacher_code: tCode, teacher_name: teacher?.name || '',
      commission: round2(commission), commission_to: commissionTo, commission_note: commissionNote,
    });
  }

  const ok = out.filter(r => r.action !== 'error');
  const summary = {
    total: out.length,
    create: out.filter(r => r.action === 'create').length,
    update: out.filter(r => r.action === 'update').length,
    errors: out.filter(r => r.action === 'error').length,
    list_total: round2(ok.reduce((a, r) => a + r.list_total, 0)),
    amount: round2(ok.reduce((a, r) => a + r.amount, 0)),
    discount: round2(ok.reduce((a, r) => a + (r.list_total - r.amount), 0)),
    commission: round2(ok.reduce((a, r) => a + r.commission, 0)),
  };
  const teacherInfo = [...new Set(ok.map(r => r.teacher_code).filter(Boolean))].map(c => {
    const t = teacherByCode.get(c);
    return {
      teacher_code: c, name: t.name, mobile: t.mobile || '',
      bulk_discount_percent: Number(t.bulk_discount_percent || 0),
      commission_enabled: t.commission_enabled === true, commission_mode: t.commission_mode || 'flat', commission_value: t.commission_value || 0,
      rules_pending: rulesPending({ ...t, rules_required: true }),   // an earlier accepted version still counts
      students: ok.filter(r => r.teacher_code === c).length,
    };
  });
  return { rows: out, summary, teachers: teacherInfo, rules: { version: RULES_VERSION, url: RULES_URL } };
}

function congratsText(teacher, count, courses, expiry) {
  return `🎉 अभिनंदन ${teacher.name}!\nतुमचे ${count} विद्यार्थी NKs EduOrbit वर ${courses.join(', ')} साठी जोडले गेले आहेत (मुदत: ${expiry.split('-').reverse().join('-')}).\nविद्यार्थ्यांना परीक्षेसाठी खूप खूप शुभेच्छा! 📚✨\n📜 पुढे जाण्यासाठी कृपया नियम मान्य करा: ${RULES_URL}?code=${encodeURIComponent(teacher.teacher_code)}`;
}

// POST /api/students/import/preview — the plan only, nothing saved
exports.previewImport = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await planImport(req.body) });
});

// POST /api/students/import — save it
exports.runImport = asyncHandler(async (req, res) => {
  const importId = String(req.body.import_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(importId)) throw new AppError('import_id is required', 400);
  const now = new Date();
  const plan = await planImport(req.body, now);
  const adminId = String(req.user?.id || '').trim();
  const results = [];
  const byTeacher = new Map(); // code → { codes:Set, batches:Map(batch → latest expiry day) }

  for (const row of plan.rows) {
    if (row.action === 'error') { results.push({ ...row, status: 'error' }); continue; }
    try {
      let student;
      if (row.action === 'create') {
        student = await User.create({
          user_id: `student-${randomUUID()}`,
          name: row.name,
          role: 'student',
          student_code: row.student_code,
          mobile: row.mobile,
          status: 'active',
          assigned_batches: row.courses,
          expiry_date: dayStart(row.expiry),
          pin_hash: User.hashPin(row.pin),
          approved_at: now,
          approved_by: adminId,
          request_source: 'admin',
          school_name: row.school,
          referred_by_teacher: row.teacher_code || '',
          free_tier: false,
        });
      } else {
        student = await User.findOne({ user_id: row.existing_id, role: 'student' });
        const batches = new Set([...(student.assigned_batches || []), ...row.courses]);
        student.assigned_batches = [...batches];
        if (!student.expiry_date || dayStart(row.expiry) > student.expiry_date) student.expiry_date = dayStart(row.expiry);
        if (!student.school_name && row.school) student.school_name = row.school;
        if (!student.referred_by_teacher && row.teacher_code) student.referred_by_teacher = row.teacher_code;
        if (student.status === 'pending') { student.status = 'active'; student.approved_at = now; student.approved_by = adminId; }
        student.free_tier = false;
        await student.save();
      }
      invalidateUserCache('student', student.user_id);

      // One paid subscription per course (same keys on a repeat → skipped)
      let firstSubId = '';
      for (let k = 0; k < row.courses.length; k += 1) {
        const key = `bulk:${importId}:${student.student_code}:${row.courses[k]}`;
        const sub = await StudentSubscription.findOneAndUpdate(
          { razorpay_payment_id: key },
          {
            $setOnInsert: {
              student_user_id: student.user_id,
              student_code: student.student_code,
              batch: row.courses[k],
              period: row.plan === 'monthly' ? 'monthly' : 'yearly',
              amount: row.amounts[k] || 0,
              list_price: row.list_prices[k] || 0,
              razorpay_payment_id: key,
              payment_verified: true,
              status: 'active',
              is_trial: false,
              start_date: now,
              expiry_date: dayEndIst(row.expiry),
              discount_applied_percent: row.discount_percent,
              discount_source: row.discount_percent ? 'teacher_bulk' : '',
              source: 'admin_bulk',
              import_id: importId,
            },
          },
          { upsert: true, new: true }
        );
        if (!firstSubId) firstSubId = String(sub._id);
      }

      // Commission on the whole amount of this import (one "payment"), by the teacher's rules
      if (row.amount > 0) {
        await recordCommissionForPayment(
          { _id: firstSubId, amount: row.amount, is_trial: false, razorpay_payment_id: `bulk:${importId}:${student.student_code}` },
          student.toObject ? student.toObject() : student
        );
      }

      if (row.teacher_code) {
        const t = byTeacher.get(row.teacher_code) || { codes: new Set(), batches: new Map() };
        t.codes.add(student.student_code);
        row.courses.forEach(b => { if (!t.batches.has(b) || t.batches.get(b) < row.expiry) t.batches.set(b, row.expiry); });
        byTeacher.set(row.teacher_code, t);
      }
      results.push({ ...row, student_code: student.student_code, status: row.action === 'create' ? 'created' : 'updated' });
    } catch (err) {
      results.push({ ...row, status: 'error', errors: [...row.errors, err.code === 11000 ? 'Code आधीच वापरात — परत प्रयत्न करा' : err.message] });
    }
  }

  const teachers = await joinTeachers(byTeacher);

  const summary = {
    ...plan.summary,
    created: results.filter(r => r.status === 'created').length,
    updated: results.filter(r => r.status === 'updated').length,
    failed: results.filter(r => r.status === 'error').length,
  };
  res.json({ success: true, data: { import_id: importId, rows: results, summary, teachers, rules: plan.rules } });
});

// Teachers: join students, Paper Builder unlimited till the students' expiry, rules required
// byTeacher: code → { codes:Set, batches:Map(batch → latest expiry day) }
async function joinTeachers(byTeacher) {
  const teachers = [];
  for (const [code, info] of byTeacher) {
    const teacher = await User.findOne({ role: 'teacher', teacher_code: code });
    if (!teacher) continue;
    const assigned = new Set([...(teacher.assigned_students || []), ...info.codes]);
    teacher.assigned_students = [...assigned];
    const unlimited = new Map((teacher.paper_unlimited || []).map(e => [e.batch, new Date(e.until)]));
    for (const [batch, day] of info.batches) {
      const until = dayEndIst(day);
      if (!unlimited.has(batch) || unlimited.get(batch) < until) unlimited.set(batch, until);
    }
    teacher.paper_unlimited = [...unlimited].map(([batch, until]) => ({ batch, until }));
    teacher.rules_required = true;
    await teacher.save();
    invalidateUserCache('teacher', teacher.user_id);

    const courses = [...info.batches.keys()];
    const expiry = [...info.batches.values()].sort().pop();
    const text = congratsText(teacher, info.codes.size, courses, expiry);
    if (teacher.device_token) {
      sendToUser(teacher.device_token, `🎉 अभिनंदन ${teacher.name}!`,
        `तुमचे ${info.codes.size} विद्यार्थी जोडले गेले. विद्यार्थ्यांना परीक्षेसाठी शुभेच्छा! Paper बनवण्याआधी नियम मान्य करा — link WhatsApp वर.`,
        { type: 'bulk_students', count: info.codes.size }).catch(err => console.warn('bulk import push:', err.message));
    }
    teachers.push({
      teacher_code: code, name: teacher.name, mobile: teacher.mobile || '', students: info.codes.size, courses, expiry,
      rules_pending: rulesPending(teacher), rules_url: `${RULES_URL}?code=${encodeURIComponent(code)}`,
      whatsapp_text: text, pushed: !!teacher.device_token,
    });
  }
  return teachers;
}

// ── one student made / renewed by hand (Admin › Students › Student Access, owner 2026-11-26): the same money
// rules as the import — plan (monthly 30 days / yearly till 30 April / own date), the courses' price minus the
// admin's discount % (or the amount typed), a paid offline subscription per course, the teacher's commission,
// and the teacher gets the student. Nothing written here.
async function planOne(b, now = new Date()) {
  const plan = PLANS.includes(b.plan) ? b.plan : null;
  if (!plan) throw new AppError('Plan निवडा', 400);
  const names = splitCourses(b.courses);
  if (!names.length) throw new AppError('Course निवडा', 400);
  const batches = await Batch.find({}, 'name monthly_price yearly_price').lean();
  const byName = new Map(batches.map(x => [x.name.trim().toLowerCase(), x]));
  const courses = [];
  for (const n of names) {
    const x = byName.get(n.toLowerCase());
    if (!x) throw new AppError(`Course सापडला नाही: ${n}`, 400);
    if (!courses.some(c => c.name === x.name)) courses.push(x);
  }
  const day = parseDay(b.expiry);
  if (day === null) throw new AppError('Expiry तारीख चुकीची', 400);
  const expiry = day || (plan === 'custom' ? '' : planExpiryDay(plan, now));
  if (!expiry) throw new AppError('Expiry तारीख निवडा', 400);
  if (expiry < istDay(now)) throw new AppError('Expiry तारीख आधीच गेली', 400);
  const disc = b.discount_percent === '' || b.discount_percent == null ? 0 : Number(b.discount_percent);
  if (!Number.isFinite(disc) || disc < 0 || disc > 100) throw new AppError('सूट 0–100 %', 400);
  const listPrices = courses.map(x => Number(plan === 'monthly' ? x.monthly_price : x.yearly_price) || 0);
  const listTotal = round2(listPrices.reduce((a, c) => a + c, 0));
  let amount = round2(listTotal * (1 - disc / 100));
  if (b.amount !== '' && b.amount != null) {
    const a = Number(b.amount);
    if (!Number.isFinite(a) || a < 0) throw new AppError('रक्कम चुकीची', 400);
    amount = round2(a);
  }
  const tCode = String(b.teacher_code || '').trim().toUpperCase();
  let teacher = null;
  if (tCode) {
    teacher = await User.findOne({ role: 'teacher', teacher_code: tCode }, 'name teacher_code status').lean();
    if (!teacher) throw new AppError(`Teacher code सापडला नाही: ${tCode}`, 400);
    if ((teacher.status || 'active') !== 'active') throw new AppError(`Teacher ${tCode} active नाही`, 400);
  }
  return { plan, expiry, courses: courses.map(x => x.name), list_prices: listPrices, list_total: listTotal, discount_percent: disc,
    amount, amounts: splitAmount(amount, listPrices), teacher_code: tCode, teacher_name: teacher?.name || '' };
}
// write it: the student's courses / expiry, one paid subscription per course (the same key twice → once), commission
async function saveOne(student, p, key, adminId, now = new Date()) {
  const batches = new Set([...(student.assigned_batches || []), ...p.courses]);
  student.assigned_batches = [...batches];
  if (!student.expiry_date || dayStart(p.expiry) > student.expiry_date) student.expiry_date = dayStart(p.expiry);
  if (!student.referred_by_teacher && p.teacher_code) student.referred_by_teacher = p.teacher_code;
  if (student.status === 'pending') { student.status = 'active'; student.approved_at = now; student.approved_by = adminId; }
  student.free_tier = false;
  await student.save();
  invalidateUserCache('student', student.user_id);
  let firstSubId = '', isNew = false;
  for (let k = 0; k < p.courses.length; k += 1) {
    const id = `single:${key}:${student.student_code}:${p.courses[k]}`;
    const r = await StudentSubscription.findOneAndUpdate(
      { razorpay_payment_id: id },
      { $setOnInsert: {
        student_user_id: student.user_id, student_code: student.student_code, batch: p.courses[k],
        period: p.plan === 'monthly' ? 'monthly' : 'yearly', amount: p.amounts[k] || 0, list_price: p.list_prices[k] || 0,
        razorpay_payment_id: id, payment_verified: true, status: 'active', is_trial: false, start_date: now, expiry_date: dayEndIst(p.expiry),
        discount_applied_percent: p.discount_percent, discount_source: p.discount_percent ? 'admin_single' : '', source: 'admin_bulk', import_id: 'single:' + key,
      } },
      { upsert: true, new: true, includeResultMetadata: true }
    );
    if (!r.lastErrorObject?.updatedExisting) isNew = true;
    if (!firstSubId) firstSubId = String(r.value._id);
  }
  if (isNew && p.amount > 0) {
    await recordCommissionForPayment(
      { _id: firstSubId, amount: p.amount, is_trial: false, razorpay_payment_id: `single:${key}:${student.student_code}` },
      student.toObject ? student.toObject() : student
    );
  }
  const teachers = p.teacher_code
    ? await joinTeachers(new Map([[p.teacher_code, { codes: new Set([student.student_code]), batches: new Map(p.courses.map(c => [c, p.expiry])) }]]))
    : [];
  return { plan: p, teachers, recorded: isNew };
}
exports.planOne = planOne;
exports.saveOne = saveOne;

// POST /api/students/plan/preview { courses, plan, expiry?, discount_percent?, amount?, teacher_code? } — the price, nothing saved
exports.previewOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await planOne(req.body || {}) });
});
// POST /api/students/:id/plan { …the same, key } — 🔁 a new plan / renewal for a student already here
exports.renewOne = asyncHandler(async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new AppError('key is required', 400);
  const student = await User.findOne({ user_id: req.params.id, role: 'student' });
  if (!student) throw new AppError('Student not found', 404);
  const p = await planOne(req.body || {});
  res.json({ success: true, data: await saveOne(student, p, key, String(req.user?.id || '').trim()) });
});

module.exports._internal = { planImport, splitAmount, parseDay, planExpiryDay };
