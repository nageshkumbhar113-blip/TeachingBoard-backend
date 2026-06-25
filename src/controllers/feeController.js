/* ════════════════════════════════════════════════════════════════
   feeController.js — Teacher fee management + cron reminder engine
════════════════════════════════════════════════════════════════ */

const FeeConfig    = require('../models/FeeConfig');
const FeeRecord    = require('../models/FeeRecord');
const User         = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../utils/AppError');
const { sendToMany } = require('../utils/fcm');

// UPI payment deep link config — fallback env vars; teachers can override per-account
const _DEFAULT_UPI_ID   = process.env.UPI_ID   || '';
const _DEFAULT_UPI_NAME = process.env.UPI_NAME || 'Teaching Board';

function _buildUpiLink(amount, label, upiId, upiName) {
  const pa = upiId   || _DEFAULT_UPI_ID;
  const pn = upiName || _DEFAULT_UPI_NAME;
  if (!pa) return null;
  return `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${amount}&cu=INR&tn=${encodeURIComponent(label)}`;
}

function _fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

function _daysLeft(dueDate) {
  const due   = new Date(dueDate); due.setHours(0,0,0,0);
  const today = new Date();        today.setHours(0,0,0,0);
  return Math.floor((due - today) / 86400000);
}

function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Create FeeConfig + auto-create FeeRecords for all batch students ──────────
exports.createFeeConfig = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const { batch, fee_type, label, total_amount, due_date, student_code } = req.body;
  if (!batch)             throw new AppError('batch is required', 400);
  if (!label?.trim())     throw new AppError('label is required', 400);
  if (!total_amount || Number(total_amount) < 1) throw new AppError('total_amount must be ≥ 1', 400);
  if (!due_date)          throw new AppError('due_date is required', 400);

  const assignedCodes = Array.isArray(teacherDoc.assigned_students) ? teacherDoc.assigned_students : [];

  // Single student or all batch students
  const studentFilter = { role: 'student', student_code: { $in: assignedCodes }, assigned_batches: batch };
  if (student_code) {
    if (!assignedCodes.includes(student_code)) throw new AppError('Student not in your assigned list', 403);
    studentFilter.student_code = student_code;
  }

  const batchStudents = await User.find(studentFilter).select('student_code name').lean();
  if (!batchStudents.length) throw new AppError('No students found in this batch', 400);

  const config = await FeeConfig.create({
    batch,
    fee_type:     fee_type || 'tuition',
    label:        label.trim(),
    total_amount: Number(total_amount),
    due_date:     new Date(due_date),
    created_by:   teacherDoc.user_id,
  });

  await FeeRecord.insertMany(
    batchStudents.map(s => ({
      fee_config_id: config.fee_config_id,
      student_code:  s.student_code,
      student_name:  s.name,
      batch,
      total_amount:  Number(total_amount),
    })),
    { ordered: false }
  );

  res.status(201).json({
    success:       true,
    fee_config_id: config.fee_config_id,
    student_count: batchStudents.length,
    message:       `Fee config created for ${batchStudents.length} students.`,
  });
});

// ── List fee configs for teacher with stats ───────────────────────────────────
exports.listFeeConfigs = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const filter = { created_by: teacherDoc.user_id };
  if (req.query.status) filter.status = req.query.status;

  const configs = await FeeConfig.find(filter).sort({ created_at: -1 }).lean();

  const result = await Promise.all(configs.map(async c => {
    const records = await FeeRecord.find(
      { fee_config_id: c.fee_config_id },
      { paid_amount: 1, total_amount: 1, status: 1 }
    ).lean();

    const total_students  = records.length;
    const paid_count      = records.filter(r => r.status === 'paid').length;
    const partial_count   = records.filter(r => r.status === 'partial').length;
    const pending_count   = records.filter(r => r.status === 'pending').length;
    const total_expected  = records.reduce((s, r) => s + r.total_amount, 0);
    const total_collected = records.reduce((s, r) => s + r.paid_amount, 0);
    const total_remaining = total_expected - total_collected;

    return { ...c, stats: { total_students, paid_count, partial_count, pending_count,
      total_expected, total_collected, total_remaining } };
  }));

  res.json({ success: true, count: result.length, configs: result });
});

// ── Get student records for a fee config ──────────────────────────────────────
exports.getRecords = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const config = await FeeConfig.findOne({
    fee_config_id: req.params.id,
    created_by:    teacherDoc.user_id,
  }).lean();
  if (!config) throw new AppError('Fee config not found', 404);

  const records = await FeeRecord.find({ fee_config_id: req.params.id })
    .sort({ student_name: 1 }).lean();

  res.json({
    success: true,
    config,
    records: records.map(r => ({ ...r, remaining_amount: Math.max(0, r.total_amount - r.paid_amount) })),
  });
});

// ── Add payment for a student ─────────────────────────────────────────────────
exports.addPayment = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const record = await FeeRecord.findOne({ fee_record_id: req.params.id });
  if (!record) throw new AppError('Fee record not found', 404);

  const config = await FeeConfig.findOne({
    fee_config_id: record.fee_config_id,
    created_by:    teacherDoc.user_id,
  }).lean();
  if (!config) throw new AppError('Unauthorized', 403);

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) throw new AppError('amount must be > 0', 400);

  record.payments.push({
    amount,
    note:      String(req.body.note || '').trim(),
    marked_by: teacherDoc.name || teacherDoc.user_id,
  });
  record.paid_amount = Math.min(record.total_amount, record.paid_amount + amount);
  const remaining    = Math.max(0, record.total_amount - record.paid_amount);
  record.status      = remaining === 0 ? 'paid' : record.paid_amount > 0 ? 'partial' : 'pending';

  await record.save();

  res.json({
    success:          true,
    paid_amount:      record.paid_amount,
    remaining_amount: remaining,
    status:           record.status,
    upi_link:         remaining > 0 ? _buildUpiLink(remaining, config.label, teacherDoc.fee_upi_id, teacherDoc.fee_upi_name) : null,
    message:          record.status === 'paid' ? '✅ पूर्ण फी मिळाली!' : `₹${remaining} बाकी आहे.`,
  });
});

// ── Update due date → resets notifications for new cycle ─────────────────────
exports.updateDueDate = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const config = await FeeConfig.findOne({ fee_config_id: req.params.id, created_by: teacherDoc.user_id });
  if (!config) throw new AppError('Fee config not found', 404);

  if (!req.body.due_date) throw new AppError('due_date is required', 400);
  config.due_date = new Date(req.body.due_date);
  config.status   = 'active';
  await config.save();

  // Reset notified_days so reminders restart for the new due date
  await FeeRecord.updateMany(
    { fee_config_id: config.fee_config_id, status: { $in: ['pending', 'partial'] } },
    { $set: { notified_days: [] } }
  );

  res.json({ success: true, message: 'Due date updated. Reminders will restart.' });
});

// ── Close fee config ──────────────────────────────────────────────────────────
exports.closeFeeConfig = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const config = await FeeConfig.findOne({ fee_config_id: req.params.id, created_by: teacherDoc.user_id });
  if (!config) throw new AppError('Fee config not found', 404);

  config.status = 'closed';
  await config.save();
  res.json({ success: true, message: 'Fee config closed.' });
});

// ── Update next installment amount + date on a record ────────────────────────
exports.updateNextInstallment = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const record = await FeeRecord.findOne({ fee_record_id: req.params.id });
  if (!record) throw new AppError('Fee record not found', 404);

  const config = await FeeConfig.findOne({
    fee_config_id: record.fee_config_id,
    created_by:    teacherDoc.user_id,
  }).lean();
  if (!config) throw new AppError('Unauthorized', 403);

  const amount = Number(req.body.amount || 0);
  if (amount < 0) throw new AppError('amount must be ≥ 0', 400);

  record.next_installment_amount = amount;
  record.next_installment_date   = req.body.date ? new Date(req.body.date) : null;
  await record.save();

  const upi_link = amount > 0 ? _buildUpiLink(amount, config.label, teacherDoc.fee_upi_id, teacherDoc.fee_upi_name) : null;
  res.json({ success: true, upi_link });
});

// ── Return teacher's UPI config ───────────────────────────────────────────────
exports.upiConfig = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);
  res.json({
    success:  true,
    upi_id:   teacherDoc.fee_upi_id   || '',
    upi_name: teacherDoc.fee_upi_name || '',
  });
});

// ── Save teacher's UPI ID + name ──────────────────────────────────────────────
exports.updateUpiSettings = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const upi_id   = String(req.body.upi_id   || '').trim();
  const upi_name = String(req.body.upi_name || '').trim();

  await teacherDoc.constructor.updateOne(
    { user_id: teacherDoc.user_id },
    { $set: { fee_upi_id: upi_id, fee_upi_name: upi_name } }
  );

  res.json({ success: true, message: 'UPI settings saved.' });
});

// ── CRON: Process fee reminders (called by cron-job.org daily at 9 AM IST) ───
exports.processReminders = asyncHandler(async (req, res) => {
  const secret   = String(req.headers['x-cron-secret'] || '').trim();
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected || secret !== expected) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const todayKey = _todayKey();
  const cutoff   = new Date(); cutoff.setDate(cutoff.getDate() - 30);

  const configs = await FeeConfig.find({ status: 'active', due_date: { $gte: cutoff } }).lean();

  // Cache teacher UPI IDs to avoid repeated DB hits
  const _teacherUpiCache = {};
  async function _getTeacherUpi(teacherId) {
    if (_teacherUpiCache[teacherId]) return _teacherUpiCache[teacherId];
    const t = await User.findOne({ user_id: teacherId }).select('fee_upi_id fee_upi_name').lean();
    _teacherUpiCache[teacherId] = { id: t?.fee_upi_id || '', name: t?.fee_upi_name || '' };
    return _teacherUpiCache[teacherId];
  }

  let notified = 0;

  for (const config of configs) {
    const days = _daysLeft(config.due_date);

    // Notify: D-7 to D-0 (7 days before + due day) + overdue up to D+30
    if (days > 7 || days < -30) continue;

    const records = await FeeRecord.find({
      fee_config_id: config.fee_config_id,
      status:        { $in: ['pending', 'partial'] },
      notified_days: { $ne: todayKey },
    }).lean();

    if (!records.length) continue;

    // Notification content based on days left
    let title, getBody;
    if (days > 0) {
      title   = `📅 फी आठवण — ${config.label}`;
      getBody = (name, rem) => `${name} ची ₹${rem} फी ${days} दिवसात भरायची आहे. (${_fmtDate(config.due_date)})`;
    } else if (days === 0) {
      title   = `⏰ आज शेवटचा दिवस — ${config.label}`;
      getBody = (name, rem) => `${name} ची ₹${rem} फी आज भरणे आवश्यक! (${_fmtDate(config.due_date)})`;
    } else {
      title   = `🔴 फी थकीत — ${config.label}`;
      getBody = (name, rem) => `${name} ची ₹${rem} फी ${_fmtDate(config.due_date)} पासून थकीत आहे. कृपया लवकर भरा.`;
    }

    for (const record of records) {
      const remaining = Math.max(0, record.total_amount - record.paid_amount);
      const body      = getBody(record.student_name, remaining);

      const parents = await User.find({
        role:         'parent',
        children:     record.student_code,
        device_token: { $exists: true, $nin: [null, ''] },
      }).select('device_token').lean();

      const tokens = [...new Set(parents.map(p => p.device_token).filter(Boolean))];
      if (tokens.length) {
        await sendToMany(tokens, title, body, {
          type:          'fee_reminder',
          fee_config_id: config.fee_config_id,
          student_code:  record.student_code,
          days_left:     String(days),
          remaining:     String(remaining),
          upi_link:      await (async () => { const u = await _getTeacherUpi(config.created_by); return _buildUpiLink(remaining, config.label, u.id, u.name); })(),
        }).catch(err => console.warn('Fee FCM error:', err.message));
        notified++;
      }

      await FeeRecord.updateOne(
        { fee_record_id: record.fee_record_id },
        { $addToSet: { notified_days: todayKey } }
      );
    }
  }

  res.json({ success: true, notified_count: notified, configs_checked: configs.length, date: todayKey });
});
