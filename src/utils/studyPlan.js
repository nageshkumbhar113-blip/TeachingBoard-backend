/**
 * Study Plan — day-count based scheduling (no minutes/time anywhere).
 * One StudyItem = one published Notes concept OR one Exercise group (all questions sharing an
 * exerciseNo). See models/StudyPlan.js, StudyPlanCursor.js, StudyTask.js for the "why" of each field.
 */
const Batch = require('../models/Batch');
const Concept = require('../models/Concept');
const SLSQuestion = require('../models/SLSQuestion');
const PassageBlock = require('../models/PassageBlock');
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

// Notes concepts, then Passage blocks, then Exercise groups, per chapter, in catalog chapter order —
// matches how a student naturally studies a lesson (learn it, read/practice the passage, then drill
// the exercises). Passage blocks only count here when tagged to one of the plan's own chapters — the
// chapterId-blank "unseen pool" used for paper generation isn't lesson-scoped, so it's excluded.
async function materializeSubjectItems(batchId, subjectId, chapterIds) {
  const chapters = await _chapterList(batchId, subjectId, chapterIds);
  const items = [];
  for (const ch of chapters) {
    const concepts = await Concept.find({ chapterId: ch.chapterId, status: 'published' }).sort({ order: 1, created_at: 1 }).lean();
    for (const c of concepts) {
      items.push({ itemType: 'notes', chapterId: ch.chapterId, chapterName: ch.name, refId: String(c._id), label: c.title?.english || c.title?.marathi || 'Notes' });
    }
    const passages = await PassageBlock.find({ chapterId: ch.chapterId, status: 'published' }).sort({ created_at: 1 }).lean();
    for (const p of passages) {
      items.push({ itemType: 'passage', chapterId: ch.chapterId, chapterName: ch.name, refId: String(p._id), label: p.title || 'Passage' });
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

const DEFAULT_MAX_ITEMS_PER_DAY = 4;      // exercise groups/day
const DEFAULT_MAX_NOTES_PER_DAY = 8;      // notes concepts/day — reading is lighter than solving, so this is looser
const DEFAULT_MAX_PASSAGES_PER_DAY = 3;   // passage blocks/day — sub-questions make these closer to exercise effort

function _perDayCaps(plan) {
  return {
    notes: plan.maxNotesPerDay || DEFAULT_MAX_NOTES_PER_DAY,
    exercise: plan.maxItemsPerDay || DEFAULT_MAX_ITEMS_PER_DAY,
    passage: plan.maxPassagesPerDay || DEFAULT_MAX_PASSAGES_PER_DAY,
  };
}
const ITEM_TYPES = ['notes', 'exercise', 'passage'];

/**
 * Checks feasibility and, unless it only warns, creates the plan + per-subject cursors + today's
 * tasks. Returns { warning: {...} } without writing anything if a subject's daily pace looks
 * unrealistic and `force` was not passed. Feasibility and daily caps are checked per item TYPE
 * (notes vs exercise) — a subject with lots of notes but few exercises should not be flagged just
 * because the combined item count looks high; each type has its own realistic daily ceiling.
 */
async function createPlan({ studentUserId, studentCode, batchId, examName, targetDateStr, offDaysOfWeek = [], revisionSharePercent = 15, subjects, force = false, maxItemsPerDay = DEFAULT_MAX_ITEMS_PER_DAY, maxNotesPerDay = DEFAULT_MAX_NOTES_PER_DAY, maxPassagesPerDay = DEFAULT_MAX_PASSAGES_PER_DAY }) {
  const startStr = todayStr();
  if (targetDateStr <= startStr) return { error: 'targetDate must be after today' };

  const totalStudyDays = countStudyDays(startStr, targetDateStr, offDaysOfWeek);
  if (totalStudyDays <= 0) return { error: 'No study days between today and the target date with these weekly offs' };
  const revisionDays = Math.max(0, Math.round(totalStudyDays * (revisionSharePercent / 100)));
  const newContentDays = Math.max(1, totalStudyDays - revisionDays);
  const caps = { notes: maxNotesPerDay, exercise: maxItemsPerDay, passage: maxPassagesPerDay };

  const built = [];
  const warnings = [];
  for (const s of subjects) {
    const items = await materializeSubjectItems(batchId, s.subjectId, s.chapterIds || []);
    const byType = Object.fromEntries(ITEM_TYPES.map(t => [t, items.filter(it => it.itemType === t).length]));
    const perDay = Object.fromEntries(ITEM_TYPES.map(t => [t, byType[t] / newContentDays]));
    if (ITEM_TYPES.some(t => perDay[t] > caps[t])) {
      warnings.push({
        subjectId: s.subjectId, totalItems: items.length,
        notesPerDay: Math.ceil(perDay.notes * 10) / 10, exercisesPerDay: Math.ceil(perDay.exercise * 10) / 10, passagesPerDay: Math.ceil(perDay.passage * 10) / 10,
      });
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
    offDaysOfWeek, revisionSharePercent, maxItemsPerDay, maxNotesPerDay, maxPassagesPerDay,
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
 * For each subject: tops today up to its per-TYPE caps (notes vs exercise — notes are just reading,
 * so they get a looser daily ceiling than exercises, which need actually solving), oldest
 * overdue-pending items first (catch-up), then new items at a rate of (items left of that type) /
 * (new-content study-days left) — so falling behind raises tomorrow's pace automatically instead of
 * losing content. The per-type cap is enforced on the catch-up side too: if a student ignores the
 * app for several days, each type's backlog drains at most its own daily cap, never dumping every
 * missed day onto the one day they return (that pile-up was the actual bug behind "5 exercises in
 * one day isn't doable" — the old code only capped *new* item generation, not carried-forward
 * backlog, which could stack unbounded).
 * Selection is "smart" in one more way: within a subject's item sequence (notes then exercises per
 * chapter, chapter by chapter), a type hitting its cap for the day does not block the other type —
 * scanning continues past it and keeps taking whatever type still has room, so a notes-heavy day
 * doesn't get stuck behind a capped-out exercise slot (or vice versa). The one thing that must stay
 * in order is items of the SAME type, since nextItemIndex only remembers "how far into this type's
 * portion of the list have we gone" per type (skippedExerciseIdx/skippedNotesIdx below) — never take
 * a later same-type item before an earlier one you skipped over.
 * Leftover overdue items simply stay pending with their old date and get reconsidered next call.
 * During the plan's last revisionSharePercent of days, no new items are added (revision-only).
 */
async function generateTasksForDate(plan, dateStr) {
  const cursors = await StudyPlanCursor.find({ studyPlanId: plan._id });
  const targetStr = dateToStr(plan.targetDate);
  const totalStudyDays = countStudyDays(dateToStr(plan.startDate), targetStr, plan.offDaysOfWeek);
  const revisionDays = Math.max(0, Math.round(totalStudyDays * (plan.revisionSharePercent / 100)));
  const newContentCutoffStr = revisionDays > 0 ? addDaysStr(targetStr, -revisionDays) : targetStr;
  const inRevisionPhase = dateStr > newContentCutoffStr;
  const caps = _perDayCaps(plan);

  for (const cursor of cursors) {
    if (!isStudyDay(dateStr, plan.offDaysOfWeek)) {
      if (cursor.lastGeneratedDate !== dateStr) { cursor.lastGeneratedDate = dateStr; await cursor.save(); }
      continue;
    }

    const usedTodayByType = Object.fromEntries(ITEM_TYPES.map(t => [t, 0]));
    for (const row of await StudyTask.aggregate([
      { $match: { studyPlanId: plan._id, subjectId: cursor.subjectId, date: dateStr } },
      { $group: { _id: '$itemType', n: { $sum: 1 } } },
    ])) usedTodayByType[row._id] = row.n;
    let usedToday = ITEM_TYPES.reduce((t, k) => t + usedTodayByType[k], 0);
    const slotsLeft = Object.fromEntries(ITEM_TYPES.map(t => [t, Math.max(0, caps[t] - usedTodayByType[t])]));

    // Catch-up: pull the oldest overdue-pending items onto today first, per type, capped at that type's slotsLeft.
    for (const type of ITEM_TYPES) {
      if (slotsLeft[type] <= 0) continue;
      const overdue = await StudyTask.find({ studyPlanId: plan._id, subjectId: cursor.subjectId, itemType: type, status: 'pending', date: { $lt: dateStr } })
        .sort({ date: 1, sequence: 1 }).limit(slotsLeft[type]).select('_id');
      if (overdue.length) {
        await StudyTask.updateMany({ _id: { $in: overdue.map(o => o._id) } }, { $set: { date: dateStr } });
        usedToday += overdue.length;
        slotsLeft[type] -= overdue.length;
      }
    }

    if (cursor.lastGeneratedDate === dateStr) continue; // new items for this date already added this run

    const take = [];
    if (!inRevisionPhase && ITEM_TYPES.some(t => slotsLeft[t] > 0)) {
      const daysLeftForNewContent = Math.max(1, countStudyDays(dateStr, newContentCutoffStr, plan.offDaysOfWeek));
      const remainingItems = cursor.items.slice(cursor.nextItemIndex);
      const remainingByType = Object.fromEntries(ITEM_TYPES.map(t => [t, remainingItems.filter(it => it.itemType === t).length]));
      const takeCap = Object.fromEntries(ITEM_TYPES.map(t => [t, Math.min(slotsLeft[t], Math.ceil(remainingByType[t] / daysLeftForNewContent))]));
      const takenByType = Object.fromEntries(ITEM_TYPES.map(t => [t, 0]));
      // Track, per type, the highest cursor.items index consumed so far in this scan — same-type
      // order is preserved even though other types may be skipped over freely.
      const maxIdxByType = Object.fromEntries(ITEM_TYPES.map(t => [t, -1]));
      for (let i = cursor.nextItemIndex; i < cursor.items.length; i++) {
        const it = cursor.items[i];
        if (takenByType[it.itemType] >= takeCap[it.itemType]) continue; // this type is full for today — skip, keep scanning
        take.push(it);
        takenByType[it.itemType]++;
        maxIdxByType[it.itemType] = i;
      }
      // nextItemIndex must remain a single contiguous pointer, so it can only advance to just past
      // the last item taken OF EITHER type that leaves no un-taken same-type item behind it.
      // Since we never skip forward within a type (continue above), the safe new pointer is one past
      // the highest index actually taken, provided every item before it was either taken or belongs
      // to a type that was skipped in full (i.e. its own maxIdx is behind). In practice — because a
      // type is either "not yet full" (everything of it up to now was taken) or "full" (skipped from
      // its first cap-exceeding item onward) — the boundary is simply the highest taken index + 1;
      // anything of the skipped type beyond that point stays for tomorrow, correctly not double-taken
      // since it's still >= nextItemIndex next time.
    }

    if (take.length) {
      try {
        await StudyTask.insertMany(take.map((it, i) => ({
          studyPlanId: plan._id, studentUserId: plan.studentUserId, date: dateStr,
          subjectId: cursor.subjectId, chapterId: it.chapterId, chapterName: it.chapterName,
          itemType: it.itemType, refId: it.refId, label: it.label,
          sequence: usedToday + i, status: 'pending',
        })), { ordered: false });
      } catch (err) {
        // A duplicate-key error here (unique index on studyPlanId+subjectId+itemType+refId) means
        // a concurrent call already created some of these — harmless, nextItemIndex still advances.
        if (!/E11000/.test(err.message || '')) throw err;
      }
      const lastIdx = cursor.nextItemIndex + cursor.items.slice(cursor.nextItemIndex).findIndex(it => it === take[take.length - 1]);
      cursor.nextItemIndex = lastIdx + 1;
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
  DEFAULT_MAX_ITEMS_PER_DAY, DEFAULT_MAX_NOTES_PER_DAY, DEFAULT_MAX_PASSAGES_PER_DAY,
};
