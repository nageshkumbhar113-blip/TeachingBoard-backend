/**
 * Study Plan — day-count based scheduling (no minutes/time anywhere).
 * One StudyItem = one published Notes concept OR one Exercise group (all questions sharing an
 * exerciseNo). See models/StudyPlan.js, StudyPlanCursor.js, StudyTask.js for the "why" of each field.
 */
const Batch = require('../models/Batch');
const Concept = require('../models/Concept');
const SLSQuestion = require('../models/SLSQuestion');
const StudyPlan = require('../models/StudyPlan');
const StudyPlanCursor = require('../models/StudyPlanCursor');
const StudyTask = require('../models/StudyTask');

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── date helpers (IST calendar date, as a 'YYYY-MM-DD' string throughout) ────

function todayStr(now = new Date()) {
  return dateToStr(now);
}
function dateToStr(d) {
  const ist = new Date(d.getTime() + IST_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}
function strToDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_MS); // the instant of local midnight for that IST date
}
function addDaysStr(s, n) {
  return dateToStr(new Date(strToDate(s).getTime() + n * DAY_MS));
}
function dayOfWeek(s) {
  return new Date(strToDate(s).getTime() + IST_MS).getUTCDay(); // 0=Sun..6=Sat, in IST
}
function isStudyDay(s, offDaysOfWeek) {
  return !(offDaysOfWeek || []).includes(dayOfWeek(s));
}
// Study days in [fromStr, toStr], both inclusive. 0 if toStr is before fromStr.
function countStudyDays(fromStr, toStr, offDaysOfWeek) {
  if (toStr < fromStr) return 0;
  let n = 0;
  for (let s = fromStr; s <= toStr; s = addDaysStr(s, 1)) if (isStudyDay(s, offDaysOfWeek)) n++;
  return n;
}
function calendarDaysBetween(fromStr, toStr) {
  return Math.round((strToDate(toStr) - strToDate(fromStr)) / DAY_MS);
}

// Natural sort for exercise numbers like "1.2", "1.10", "2" — numeric chunks compare as numbers.
function _naturalCompare(a, b) {
  const pa = String(a).match(/\d+|\D+/g) || [];
  const pb = String(b).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = Number(x), ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') { if (nx !== ny) return nx - ny; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── content sizing: one subject's ordered StudyItem list ────────────────────

async function _chapterList(batchId, subjectId, chapterIds) {
  if (Array.isArray(chapterIds) && chapterIds.length) {
    return chapterIds.map(id => ({ chapterId: id, name: String(id).split('::')[2] || id }));
  }
  const batch = await Batch.findOne({ name: batchId, 'subjects.name': subjectId }).lean();
  const subjectDoc = batch?.subjects.find(s => s.name === subjectId);
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
  const chapters = (subjectDoc?.chapters || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return chapters.map(c => ({ chapterId: `${norm(batchId)}::${norm(subjectId)}::${norm(c.name)}`, name: c.name }));
}

// Notes concepts, then Exercise groups, per chapter, in catalog chapter order — matches how a
// student naturally studies a lesson (learn it, then practice it).
async function materializeSubjectItems(batchId, subjectId, chapterIds) {
  const chapters = await _chapterList(batchId, subjectId, chapterIds);
  const items = [];
  for (const ch of chapters) {
    const concepts = await Concept.find({ chapterId: ch.chapterId, status: 'published' }).sort({ order: 1, created_at: 1 }).lean();
    for (const c of concepts) {
      items.push({ itemType: 'notes', chapterId: ch.chapterId, chapterName: ch.name, refId: String(c._id), label: c.title?.english || c.title?.marathi || 'Notes' });
    }
    const exerciseNos = await SLSQuestion.distinct('exerciseNo', { chapterId: ch.chapterId, status: 'published', exerciseNo: { $ne: '' } });
    exerciseNos.sort(_naturalCompare);
    for (const no of exerciseNos) {
      items.push({ itemType: 'exercise', chapterId: ch.chapterId, chapterName: ch.name, refId: no, label: `Exercise ${no}` });
    }
  }
  return items;
}

// ── plan creation ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITEMS_PER_DAY = 4;

/**
 * Checks feasibility and, unless it only warns, creates the plan + per-subject cursors + today's
 * tasks. Returns { warning: {...} } without writing anything if a subject's daily pace looks
 * unrealistic and `force` was not passed.
 */
async function createPlan({ studentUserId, studentCode, batchId, examName, targetDateStr, offDaysOfWeek = [], revisionSharePercent = 15, subjects, force = false, maxItemsPerDay = DEFAULT_MAX_ITEMS_PER_DAY }) {
  const startStr = todayStr();
  if (targetDateStr <= startStr) return { error: 'targetDate must be after today' };

  const totalStudyDays = countStudyDays(startStr, targetDateStr, offDaysOfWeek);
  if (totalStudyDays <= 0) return { error: 'No study days between today and the target date with these weekly offs' };
  const revisionDays = Math.max(0, Math.round(totalStudyDays * (revisionSharePercent / 100)));
  const newContentDays = Math.max(1, totalStudyDays - revisionDays);

  const built = [];
  const warnings = [];
  for (const s of subjects) {
    const items = await materializeSubjectItems(batchId, s.subjectId, s.chapterIds || []);
    const perDay = items.length / newContentDays;
    if (perDay > maxItemsPerDay) {
      warnings.push({ subjectId: s.subjectId, totalItems: items.length, itemsPerDay: Math.ceil(perDay * 10) / 10 });
    }
    built.push({ subjectId: s.subjectId, chapterIds: s.chapterIds || [], items });
  }
  if (warnings.length && !force) {
    return { warning: true, message: 'This pace looks hard to keep up with every day. Increase the target date, or reduce the subjects/lessons.', details: warnings };
  }

  // Only one active plan per student — starting a new one retires the old (its history stays, just not "active").
  await StudyPlan.updateMany({ studentUserId, status: 'active' }, { $set: { status: 'abandoned' } });

  const totalItemsOverall = built.reduce((t, s) => t + s.items.length, 0);
  const plan = await StudyPlan.create({
    studentUserId, studentCode, batchId, examName,
    startDate: strToDate(startStr), targetDate: strToDate(targetDateStr),
    offDaysOfWeek, revisionSharePercent,
    subjects: built.map(s => ({ subjectId: s.subjectId, chapterIds: s.chapterIds, totalItems: s.items.length })),
    totalItemsOverall,
    status: 'active',
  });

  for (const s of built) {
    await StudyPlanCursor.create({ studyPlanId: plan._id, subjectId: s.subjectId, items: s.items, nextItemIndex: 0, lastGeneratedDate: '' });
  }

  await generateTasksForDate(plan, startStr);
  return { plan };
}

// ── daily generation (idempotent — safe to call any number of times for any date) ──────────────

/**
 * For each subject: carries any older still-pending tasks forward onto `dateStr`, then — if
 * `dateStr` hasn't been generated for yet — adds new items at a rate of (items left) / (new-content
 * study-days left), so falling behind automatically raises tomorrow's pace instead of losing content.
 * During the plan's last revisionSharePercent of days, no new items are added (revision-only).
 */
async function generateTasksForDate(plan, dateStr) {
  const cursors = await StudyPlanCursor.find({ studyPlanId: plan._id });
  const targetStr = dateToStr(plan.targetDate);
  const totalStudyDays = countStudyDays(dateToStr(plan.startDate), targetStr, plan.offDaysOfWeek);
  const revisionDays = Math.max(0, Math.round(totalStudyDays * (plan.revisionSharePercent / 100)));
  const newContentCutoffStr = revisionDays > 0 ? addDaysStr(targetStr, -revisionDays) : targetStr;
  const inRevisionPhase = dateStr > newContentCutoffStr;

  for (const cursor of cursors) {
    // Carry forward: anything still pending from an earlier date moves onto dateStr. This runs
    // every call (even if dateStr was already generated) so a student opening the app late in the
    // day still sees yesterday's leftovers folded into today, not stuck in the past.
    await StudyTask.updateMany(
      { studyPlanId: plan._id, subjectId: cursor.subjectId, status: 'pending', date: { $lt: dateStr } },
      { $set: { date: dateStr } }
    );

    if (cursor.lastGeneratedDate === dateStr) continue; // new items for this date already added
    if (!isStudyDay(dateStr, plan.offDaysOfWeek)) { cursor.lastGeneratedDate = dateStr; await cursor.save(); continue; }

    const remaining = cursor.items.length - cursor.nextItemIndex;
    let take = [];
    if (remaining > 0 && !inRevisionPhase) {
      const daysLeftForNewContent = Math.max(1, countStudyDays(dateStr, newContentCutoffStr, plan.offDaysOfWeek));
      const quota = Math.ceil(remaining / daysLeftForNewContent);
      take = cursor.items.slice(cursor.nextItemIndex, cursor.nextItemIndex + quota);
    }

    if (take.length) {
      const existingToday = await StudyTask.countDocuments({ studyPlanId: plan._id, date: dateStr });
      try {
        await StudyTask.insertMany(take.map((it, i) => ({
          studyPlanId: plan._id, studentUserId: plan.studentUserId, date: dateStr,
          subjectId: cursor.subjectId, chapterId: it.chapterId, chapterName: it.chapterName,
          itemType: it.itemType, refId: it.refId, label: it.label,
          sequence: existingToday + i, status: 'pending',
        })), { ordered: false });
      } catch (err) {
        // A duplicate-key error here (unique index on studyPlanId+subjectId+itemType+refId) means
        // a concurrent call already created some of these — harmless, nextItemIndex still advances.
        if (!/E11000/.test(err.message || '')) throw err;
      }
      cursor.nextItemIndex += take.length;
    }
    cursor.lastGeneratedDate = dateStr;
    await cursor.save();
  }
}

async function getTodayTasks(plan) {
  const today = todayStr();
  await generateTasksForDate(plan, today);
  return StudyTask.find({ studyPlanId: plan._id, date: today }).sort({ sequence: 1 }).lean();
}

// ── progress / streak / on-track (always computed from StudyTask, never stored) ────────────────

async function getProgress(plan) {
  const today = todayStr();
  const startStr = dateToStr(plan.startDate);
  const targetStr = dateToStr(plan.targetDate);

  const [completedOverall, todayTasks] = await Promise.all([
    StudyTask.countDocuments({ studyPlanId: plan._id, status: 'completed' }),
    StudyTask.find({ studyPlanId: plan._id, date: today }).lean(),
  ]);
  const overallPercent = plan.totalItemsOverall > 0 ? Math.round((completedOverall / plan.totalItemsOverall) * 100) : 0;

  const bySubject = [];
  for (const s of plan.subjects) {
    const completed = await StudyTask.countDocuments({ studyPlanId: plan._id, subjectId: s.subjectId, status: 'completed' });
    bySubject.push({ subjectId: s.subjectId, totalItems: s.totalItems, completed, percent: s.totalItems > 0 ? Math.round((completed / s.totalItems) * 100) : 0 });
  }

  const totalStudyDays = countStudyDays(startStr, targetStr, plan.offDaysOfWeek);
  const elapsedStudyDays = Math.min(totalStudyDays, countStudyDays(startStr, today, plan.offDaysOfWeek));
  const expectedPercent = totalStudyDays > 0 ? Math.round((elapsedStudyDays / totalStudyDays) * 100) : 0;
  const onTrackDiff = overallPercent - expectedPercent; // positive = ahead, negative = behind

  const calendarDaysLeft = Math.max(0, calendarDaysBetween(today, targetStr));

  // Streak: walk back day by day from today; an off-day is skipped (doesn't break or extend it); a
  // study day with at least one completed task extends it; a study day with none breaks it.
  // One query for every completed date, then a plain in-memory walk — not one query per day.
  const completedDates = new Set(await StudyTask.distinct('date', { studyPlanId: plan._id, status: 'completed' }));
  let streak = 0;
  for (let d = today; d >= startStr; d = addDaysStr(d, -1)) {
    if (!isStudyDay(d, plan.offDaysOfWeek)) continue;
    if (completedDates.has(d)) streak++; else break;
  }

  return {
    overallPercent, remainingPercent: 100 - overallPercent,
    completedOverall, totalItemsOverall: plan.totalItemsOverall,
    bySubject,
    today: { completed: todayTasks.filter(t => t.status === 'completed').length, total: todayTasks.length },
    onTrack: { expectedPercent, actualPercent: overallPercent, diff: onTrackDiff, status: onTrackDiff >= -2 ? (onTrackDiff > 2 ? 'ahead' : 'on_track') : 'behind' },
    examCountdownDays: calendarDaysLeft,
    streak,
  };
}

module.exports = {
  todayStr, dateToStr, strToDate, addDaysStr, countStudyDays, calendarDaysBetween,
  materializeSubjectItems, createPlan, generateTasksForDate, getTodayTasks, getProgress,
  DEFAULT_MAX_ITEMS_PER_DAY,
};
