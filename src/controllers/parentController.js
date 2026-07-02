const { randomUUID } = require('crypto');
const User = require('../models/User');
const Attempt = require('../models/Attempt');
const FeeRecord = require('../models/FeeRecord');
const FeeConfig  = require('../models/FeeConfig');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStudentCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => normalizeCode(item)).filter(Boolean))];
}

// A "parent" session may be backed by a real Parent document (children:
// [...multiple codes]) or by a Student document used via its own code+PIN
// (single child = themselves). Resolve either shape to a flat code list.
function _resolveChildCodes(parentDoc) {
  if (parentDoc.role === 'student') {
    return parentDoc.student_code ? [normalizeCode(parentDoc.student_code)] : [];
  }
  return Array.isArray(parentDoc.children) ? parentDoc.children.map(normalizeCode) : [];
}

function serializeParent(p) {
  return {
    id: p.user_id,
    name: p.name,
    role: 'parent',
    parent_code: p.parent_code || '',
    mobile: p.mobile || '',
    children: Array.isArray(p.children) ? p.children : [],
    last_login_at: p.last_login_at || null,
    created_at: p.created_at || null,
  };
}

// ── Admin: CRUD ──────────────────────────────────────────────────────────────

exports.getParents = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);
  const parents = await User.find({ role: 'parent' })
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  res.json({ success: true, count: parents.length, skip, limit, data: parents.map(serializeParent) });
});

exports.createParent = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const pin  = String(req.body.pin  || '').trim();
  let parentCode = normalizeCode(req.body.parent_code);

  if (!name) throw new AppError('name is required', 400);
  if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);

  // Auto-generate parent_code if not provided
  if (!parentCode) {
    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'PAR';
    let attempts = 0;
    do {
      parentCode = 'P' + prefix.slice(0, 2) + String(Math.floor(100 + Math.random() * 900));
      attempts++;
    } while (attempts < 10 && await User.findOne({ parent_code: parentCode }));
  } else {
    const existing = await User.findOne({ parent_code: parentCode });
    if (existing) throw new AppError('Parent code already exists', 409);
  }

  const parent = await User.create({
    user_id: `parent-${randomUUID()}`,
    name,
    role: 'parent',
    parent_code: parentCode,
    mobile: String(req.body.mobile || '').trim(),
    children: normalizeStudentCodes(req.body.children),
    pin_hash: User.hashPin(pin),
  });

  res.status(201).json({ success: true, data: serializeParent(parent), pin });
});

exports.updateParent = asyncHandler(async (req, res) => {
  const parent = await User.findOne({ user_id: req.params.id, role: 'parent' });
  if (!parent) throw new AppError('Parent not found', 404);

  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) throw new AppError('name is required', 400);
    parent.name = name;
  }

  if (req.body.mobile !== undefined) {
    parent.mobile = String(req.body.mobile || '').trim();
  }

  if (req.body.children !== undefined) {
    parent.children = normalizeStudentCodes(req.body.children);
  }

  if (req.body.pin !== undefined) {
    const pin = String(req.body.pin || '').trim();
    if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);
    parent.pin_hash = User.hashPin(pin);
  }

  await parent.save();
  res.json({ success: true, data: serializeParent(parent) });
});

exports.deleteParent = asyncHandler(async (req, res) => {
  const parent = await User.findOne({ user_id: req.params.id, role: 'parent' });
  if (!parent) throw new AppError('Parent not found', 404);
  await parent.deleteOne();
  res.json({ success: true, message: 'Parent deleted' });
});

// ── Parent: own children progress ────────────────────────────────────────────

exports.getMyChildren = asyncHandler(async (req, res) => {
  const parentDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!parentDoc) throw new AppError('Parent not found', 404);

  const childCodes = _resolveChildCodes(parentDoc);

  if (!childCodes.length) {
    return res.json({ success: true, data: [] });
  }

  const children = await User.find({ student_code: { $in: childCodes }, role: 'student' })
    .select('user_id name student_code mobile school_name assigned_batches')
    .lean();

  const statsPipeline = [
    { $match: { student_code: { $in: childCodes } } },
    {
      $group: {
        _id: '$student_code',
        total_attempts: { $sum: 1 },
        total_score: { $sum: '$score' },
        total_questions: { $sum: '$total_questions' },
        last_attempt: { $max: '$submitted_at' },
      }
    }
  ];
  const stats = await Attempt.aggregate(statsPipeline);
  const statsMap = new Map(stats.map(s => [s._id, s]));

  const data = children.map(c => {
    const st = statsMap.get(c.student_code) || {};
    const totalQ = st.total_questions || 0;
    return {
      student_code: c.student_code,
      name: c.name,
      mobile: c.mobile || '',
      school_name: c.school_name || '',
      assigned_batches: c.assigned_batches || [],
      total_attempts: st.total_attempts || 0,
      avg_score_pct: totalQ > 0 ? Math.round((st.total_score / totalQ) * 100) : 0,
      last_attempt: st.last_attempt || null,
    };
  });

  res.json({ success: true, data });
});

exports.getChildAttempts = asyncHandler(async (req, res) => {
  const parentDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!parentDoc) throw new AppError('Parent not found', 404);

  const studentCode = normalizeCode(req.params.code);
  if (!studentCode) throw new AppError('student_code is required', 400);

  const childCodes = _resolveChildCodes(parentDoc);
  if (!childCodes.includes(studentCode)) {
    throw new AppError('Student is not your child', 403);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);

  const attempts = await Attempt.find({ student_code: studentCode })
    .sort({ submitted_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ success: true, count: attempts.length, skip, limit, data: attempts });
});

// ── Parent: child fee records ─────────────────────────────────────────────────

exports.getChildFee = asyncHandler(async (req, res) => {
  const parentDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!parentDoc) throw new AppError('Parent not found', 404);

  const studentCode = normalizeCode(req.params.code);
  if (!studentCode) throw new AppError('student_code is required', 400);

  const childCodes = _resolveChildCodes(parentDoc);
  if (!childCodes.includes(studentCode))
    throw new AppError('Student is not your child', 403);

  const records = await FeeRecord.find({ student_code: studentCode })
    .sort({ created_at: -1 })
    .lean();

  if (!records.length) return res.json({ success: true, data: [] });

  const configIds = [...new Set(records.map(r => r.fee_config_id))];
  const configs   = await FeeConfig.find({ fee_config_id: { $in: configIds } }).lean();
  const configMap = new Map(configs.map(c => [c.fee_config_id, c]));

  const data = records.map(r => {
    const cfg = configMap.get(r.fee_config_id) || {};
    return {
      fee_record_id:           r.fee_record_id,
      label:                   cfg.label || '',
      fee_type:                cfg.fee_type || 'tuition',
      due_date:                cfg.due_date || null,
      config_status:           cfg.status || 'active',
      total_amount:            r.total_amount,
      paid_amount:             r.paid_amount,
      status:                  r.status,
      next_installment_amount: r.next_installment_amount,
      next_installment_date:   r.next_installment_date,
      payments:                r.payments.map(p => ({
        amount:       p.amount,
        paid_at:      p.paid_at,
        payment_mode: p.payment_mode,
        note:         p.note,
      })),
    };
  });

  res.json({ success: true, data });
});

// ── Parent: register FCM device token ────────────────────────────────────────

exports.updateDeviceToken = asyncHandler(async (req, res) => {
  const token = String(req.body.device_token || '').trim();
  if (!token) throw new AppError('device_token is required', 400);

  await User.updateOne({ user_id: req.user.id }, { $set: { device_token: token } });
  res.json({ success: true, message: 'Device token updated' });
});
