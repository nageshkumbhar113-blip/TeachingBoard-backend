const PaperQuotaConfig = require('../models/PaperQuotaConfig');
const PracticePaper = require('../models/PracticePaper');
const StudentSubscription = require('../models/StudentSubscription');

// Teacher Paper Builder quota, per batch:
//  - `limit` free papers (papers saved since config.effective_from)
//  - unlimited once `need` of the teacher's students in that batch have a
//    verified, active, unexpired PAID subscription (admin-granted expiry
//    dates and free trials never count)
//  - an admin override on the teacher (batch or '*') can force unlimited or
//    change the two numbers.

async function getConfig() {
  return PaperQuotaConfig.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

async function countPaidStudents(teacherDoc, batch) {
  const codes = (teacherDoc.assigned_students || []).filter(Boolean);
  if (!codes.length) return 0;
  const paid = await StudentSubscription.distinct('student_code', {
    student_code: { $in: codes },
    batch,
    payment_verified: true,
    is_trial: false,
    status: 'active',
    expiry_date: { $gt: new Date() },
  });
  return paid.length;
}

function findOverride(teacherDoc, batch) {
  const list = teacherDoc.paper_quota_overrides || [];
  return list.find(o => o.batch === batch) || list.find(o => o.batch === '*') || null;
}

async function getQuota(teacherDoc, batch, cfg) {
  const config = cfg || await getConfig();
  const ov = findOverride(teacherDoc, batch);
  const custom = ov && ov.mode === 'custom';
  const limit = custom && ov.free_papers != null ? ov.free_papers : config.free_papers;
  const need  = custom && ov.unlock_paid_students != null ? ov.unlock_paid_students : config.unlock_paid_students;

  const [used, paid] = await Promise.all([
    PracticePaper.countDocuments({
      createdBy: teacherDoc.user_id,
      batchId: batch,
      created_at: { $gte: config.effective_from },
    }),
    countPaidStudents(teacherDoc, batch),
  ]);

  const unlimited = (ov && ov.mode === 'unlimited') || paid >= need;
  return {
    batch,
    used,
    limit,
    paid,
    need,
    remaining_students: Math.max(0, need - paid),
    unlimited: !!unlimited,
    allowed: !!unlimited || used < limit,
    override: ov ? ov.mode : null,
  };
}

function limitMessage(q) {
  return `You have used the ${q.limit} free papers for this batch. Unlimited Paper Builder unlocks when ${q.need} students of this batch have paid (${q.paid} / ${q.need} so far).`;
}

module.exports = { getConfig, countPaidStudents, getQuota, limitMessage };
