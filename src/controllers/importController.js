const { randomUUID } = require('crypto');
const { mongoose } = require('../config/db');
const Batch = require('../models/Batch');
const Concept = require('../models/Concept');
const SLSQuestion = require('../models/SLSQuestion');
const Question = require('../models/Question');
const Quiz = require('../models/Quiz');
const Note = require('../models/Note');
const ImportJob = require('../models/ImportJob');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { makeChapterId, invalidateContentAccessCache } = require('../utils/contentAccess');

// Admin > Import: COPY Notes (concepts), Exercises, MCQ questions, Tests and PDF
// notes of one batch/subject into another batch/subject, so shared content
// (e.g. English-medium Maths in two batches) is entered once. Copies are normal
// independent documents — every existing per-batch rule (student access, offline
// sync, free chapters, quota) keeps working unchanged. Each copy remembers where
// it came from (importedFrom) and which job made it (importJobId) so a repeat
// import skips what is already there and a whole job can be undone.

const TYPES = ['notes', 'exercises', 'mcq', 'quizzes', 'pdf'];

const slug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
const normText = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whitespace-insensitive, case-insensitive exact match ("Science  II" == "Science II").
const looseRx = s => new RegExp('^\\s*' + String(s || '').trim().split(/\s+/).map(esc).join('\\s+') + '\\s*$', 'i');
const prettify = sl => sl.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function str(v) { return String(v == null ? '' : v).trim(); }

function parseRequest(body) {
  const source = { batch: str(body?.source?.batch), subject: str(body?.source?.subject) };
  const target = { batch: str(body?.target?.batch), subject: str(body?.target?.subject) };
  if (!source.batch || !source.subject) throw new AppError('source batch and subject are required', 400);
  if (!target.batch || !target.subject) throw new AppError('target batch and subject are required', 400);
  if (slug(source.batch) === slug(target.batch) && slug(source.subject) === slug(target.subject)) {
    throw new AppError('Source and target are the same batch and subject', 400);
  }
  const types = Array.isArray(body?.types) && body.types.length
    ? body.types.filter(t => TYPES.includes(t))
    : TYPES.slice();
  if (!types.length) throw new AppError('Select at least one content type', 400);
  const chapters = Array.isArray(body?.chapters) ? body.chapters.map(str).filter(Boolean) : [];
  const chapterMap = body?.chapterMap && typeof body.chapterMap === 'object' ? body.chapterMap : {};
  return { source, target, types, chapters, chapterMap, asDraft: !!body?.asDraft };
}

// ── Load everything of one source batch/subject, grouped by chapter ───────────
async function loadSource(batch, subject) {
  const prefix = makeChapterId(batch, subject, '');
  const idRx = new RegExp('^' + esc(prefix));
  const bRx = looseRx(batch);
  const sRx = looseRx(subject);

  const [batchDoc, concepts, sls, questions, quizzes, notes] = await Promise.all([
    Batch.findOne({ name: batch }).lean(),
    Concept.find({ chapterId: idRx, status: { $ne: 'archived' } }).sort({ order: 1 }).lean(),
    SLSQuestion.find({ chapterId: idRx, status: { $ne: 'archived' } }).sort({ exerciseNo: 1, created_at: 1 }).lean(),
    Question.find({ batch: bRx, subject: sRx }).lean(),
    Quiz.find({ batch: bRx, subject: sRx }).lean(),
    Note.find({ batch: bRx, subject: sRx, status: 'active' }).lean(),
  ]);

  const chapters = new Map(); // slug -> group
  const group = (name, order) => {
    const k = slug(name);
    if (!k) return null;
    if (!chapters.has(k)) chapters.set(k, { key: k, name, order: order ?? null, concepts: [], sls: [], questions: [], quizzes: [], notes: [] });
    const g = chapters.get(k);
    if (g.order == null && order != null) g.order = order;
    return g;
  };

  const catSubject = (batchDoc?.subjects || []).find(s => slug(s.name) === slug(subject));
  (catSubject?.chapters || []).forEach(c => group(c.name, c.order || 0));

  for (const c of concepts) {
    const k = c.chapterId.split('::')[2];
    const g = chapters.get(k) || group(c.aiContext?.chapter || prettify(k));
    g?.concepts.push(c);
  }
  for (const q of sls) {
    const k = q.chapterId.split('::')[2];
    const g = chapters.get(k) || group(prettify(k));
    g?.sls.push(q);
  }
  for (const q of questions) group(q.chapter)?.questions.push(q);
  for (const q of quizzes) group(q.chapter)?.quizzes.push(q);
  for (const n of notes) group(n.chapter)?.notes.push(n);

  return { batchDoc, chapters };
}

function isMixedQuiz(q) {
  if (q.paper_mode === 'mixed') return true;
  return (q.sections || []).some(s =>
    (s.chapter && slug(s.chapter) !== slug(q.chapter)) ||
    (s.source_batch && slug(s.source_batch) !== slug(q.batch))
  );
}

// ── What already exists in the target subject (for duplicate detection) ───────
async function loadTargetExisting(batch, subject) {
  const prefix = makeChapterId(batch, subject, '');
  const idRx = new RegExp('^' + esc(prefix));
  const bRx = looseRx(batch);
  const sRx = looseRx(subject);

  const [concepts, sls, questions, quizzes, notes] = await Promise.all([
    Concept.find({ chapterId: idRx }, 'chapterId title.english order importedFrom.id').lean(),
    SLSQuestion.find({ chapterId: idRx }, 'chapterId exerciseNo questionText.english importedFrom.id').lean(),
    Question.find({ batch: bRx, subject: sRx }, 'chapter question importedFrom.id').lean(),
    Quiz.find({ batch: bRx, subject: sRx }, 'chapter title importedFrom.id').lean(),
    Note.find({ batch: bRx, subject: sRx }, 'chapter title importedFrom.id').lean(),
  ]);

  const seen = new Set();
  const add = (type, ch, key, importedId) => {
    seen.add(`${type}|${ch}|k:${key}`);
    if (importedId) seen.add(`${type}|${ch}|i:${importedId}`);
  };
  const conceptIdByImported = new Map(); // source concept id -> existing target concept _id
  const maxOrder = new Map();            // target chapter slug -> max concept order

  for (const c of concepts) {
    const ch = c.chapterId.split('::')[2];
    add('notes', ch, normText(c.title?.english), c.importedFrom?.id);
    if (c.importedFrom?.id) conceptIdByImported.set(c.importedFrom.id, c._id);
    maxOrder.set(ch, Math.max(maxOrder.get(ch) || 0, c.order || 0));
  }
  for (const q of sls) add('exercises', q.chapterId.split('::')[2], `${q.exerciseNo}|${normText(q.questionText?.english)}`, q.importedFrom?.id);
  for (const q of questions) add('mcq', slug(q.chapter), normText(q.question), q.importedFrom?.id);
  for (const q of quizzes) add('quizzes', slug(q.chapter), normText(q.title), q.importedFrom?.id);
  for (const n of notes) add('pdf', slug(n.chapter), normText(n.title), n.importedFrom?.id);

  return { seen, conceptIdByImported, maxOrder };
}

// ── Build the plan (used by both preview and run) ─────────────────────────────
async function buildPlan(reqInfo) {
  const { source, target, types, chapters: wanted, chapterMap } = reqInfo;

  const targetBatch = await Batch.findOne({ name: target.batch });
  if (!targetBatch) throw new AppError('Target batch not found in the batch catalog', 404);

  const { batchDoc: sourceBatch, chapters: srcChapters } = await loadSource(source.batch, source.subject);
  if (!srcChapters.size) throw new AppError('No content found in the source batch/subject', 404);

  const tgtSubject = (targetBatch.subjects || []).find(s => slug(s.name) === slug(target.subject));
  const tgtSubjectName = tgtSubject ? tgtSubject.name : target.subject;
  const tgtCatalog = new Map((tgtSubject?.chapters || []).map(c => [slug(c.name), c.name]));

  const existing = await loadTargetExisting(target.batch, tgtSubjectName);

  const wantedKeys = wanted.length ? new Set(wanted.map(slug)) : null;
  const standardNum = parseInt((String(targetBatch.standard || '').match(/\d+/) || [])[0], 10);

  const plans = [];
  const ordered = [...srcChapters.values()].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name));
  for (const g of ordered) {
    if (wantedKeys && !wantedKeys.has(g.key)) continue;
    const mappedName = str(chapterMap[g.name]);
    const tgtKey = slug(mappedName || g.name);
    const catalogName = tgtCatalog.get(tgtKey);
    const tgtName = catalogName || mappedName || g.name;
    const tgtIsNew = !catalogName;
    const tgtChapterId = makeChapterId(target.batch, tgtSubjectName, tgtName);

    const isDup = (type, key, importedId) =>
      existing.seen.has(`${type}|${tgtKey}|k:${key}`) || existing.seen.has(`${type}|${tgtKey}|i:${importedId}`);

    const items = { notes: [], exercises: [], mcq: [], quizzes: [], pdf: [] };
    const counts = {};
    for (const t of TYPES) counts[t] = { total: 0, fresh: 0, duplicate: 0 };
    let mixedSkipped = 0;

    if (types.includes('notes')) for (const c of g.concepts) {
      counts.notes.total++;
      if (isDup('notes', normText(c.title?.english), String(c._id))) counts.notes.duplicate++;
      else { counts.notes.fresh++; items.notes.push(c); }
    }
    if (types.includes('exercises')) for (const q of g.sls) {
      counts.exercises.total++;
      if (isDup('exercises', `${q.exerciseNo}|${normText(q.questionText?.english)}`, String(q._id))) counts.exercises.duplicate++;
      else { counts.exercises.fresh++; items.exercises.push(q); }
    }
    if (types.includes('mcq')) for (const q of g.questions) {
      counts.mcq.total++;
      if (isDup('mcq', normText(q.question), q.q_id)) counts.mcq.duplicate++;
      else { counts.mcq.fresh++; items.mcq.push(q); }
    }
    if (types.includes('quizzes')) for (const q of g.quizzes) {
      if (isMixedQuiz(q)) { mixedSkipped++; continue; }
      counts.quizzes.total++;
      if (isDup('quizzes', normText(q.title), q.quiz_id)) counts.quizzes.duplicate++;
      else { counts.quizzes.fresh++; items.quizzes.push(q); }
    }
    if (types.includes('pdf')) for (const n of g.notes) {
      counts.pdf.total++;
      if (isDup('pdf', normText(n.title), n.note_id)) counts.pdf.duplicate++;
      else { counts.pdf.fresh++; items.pdf.push(n); }
    }

    plans.push({
      srcName: g.name, srcKey: g.key, srcOrder: g.order,
      tgtName, tgtKey, tgtIsNew, tgtChapterId,
      counts, mixedSkipped, items,
      existingMaxOrder: existing.maxOrder.get(tgtKey) || 0,
    });
  }
  if (!plans.length) throw new AppError('None of the selected chapters have content in the source', 404);

  return { plans, targetBatch, tgtSubject, tgtSubjectName, existing, standardNum: Number.isFinite(standardNum) ? standardNum : null, sourceBatch };
}

function summarize(plans) {
  const totals = {};
  for (const t of TYPES) totals[t] = { total: 0, fresh: 0, duplicate: 0 };
  let mixed = 0;
  for (const p of plans) {
    mixed += p.mixedSkipped;
    for (const t of TYPES) {
      totals[t].total += p.counts[t].total;
      totals[t].fresh += p.counts[t].fresh;
      totals[t].duplicate += p.counts[t].duplicate;
    }
  }
  return { totals, mixed_quizzes_skipped: mixed };
}

// ── GET /source-chapters?batch=&subject= ──────────────────────────────────────
exports.listSourceChapters = asyncHandler(async (req, res) => {
  const batch = str(req.query.batch);
  const subject = str(req.query.subject);
  if (!batch || !subject) throw new AppError('batch and subject are required', 400);

  const { chapters } = await loadSource(batch, subject);
  const data = [...chapters.values()]
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name))
    .map(g => ({
      name: g.name,
      order: g.order,
      counts: {
        notes: g.concepts.length,
        exercises: g.sls.length,
        mcq: g.questions.length,
        quizzes: g.quizzes.filter(q => !isMixedQuiz(q)).length,
        pdf: g.notes.length,
      },
    }));
  res.json({ success: true, data });
});

// ── POST /preview ─────────────────────────────────────────────────────────────
exports.preview = asyncHandler(async (req, res) => {
  const info = parseRequest(req.body);
  const plan = await buildPlan(info);
  res.json({
    success: true,
    data: {
      target_subject: plan.tgtSubjectName,
      target_subject_exists: !!plan.tgtSubject,
      target_has_chapters: (plan.tgtSubject?.chapters || []).length > 0,
      chapters: plan.plans.map(p => ({
        name: p.srcName,
        target_name: p.tgtName,
        target_is_new: p.tgtIsNew,
        counts: p.counts,
        mixed_quizzes_skipped: p.mixedSkipped,
      })),
      ...summarize(plan.plans),
    },
  });
});

// ── POST /run ─────────────────────────────────────────────────────────────────
async function insertChunks(Model, docs) {
  let inserted = 0;
  for (let i = 0; i < docs.length; i += 200) {
    const slice = docs.slice(i, i + 200);
    await Model.insertMany(slice, { ordered: true });
    inserted += slice.length;
  }
  return inserted;
}

exports.run = asyncHandler(async (req, res) => {
  const info = parseRequest(req.body);
  const { source, target, types, asDraft } = info;
  const adminId = req.user?.id || 'admin';
  const now = new Date();
  const jobId = `imp_${randomUUID()}`;

  const plan = await buildPlan(info);
  const { plans, targetBatch, tgtSubjectName, existing, standardNum } = plan;

  const job = await ImportJob.create({
    job_id: jobId, created_by: adminId, source, target: { batch: target.batch, subject: tgtSubjectName },
    types, as_draft: asDraft, results: { running: true },
  });

  const tag = { importJobId: jobId };
  const results = {};
  for (const t of TYPES) results[t] = { created: 0, skipped: 0 };
  const createdChapters = [];
  let createdSubject = false;

  try {
    // 1) Target catalog: subject + any chapter that does not exist yet.
    let sub = (targetBatch.subjects || []).find(s => slug(s.name) === slug(tgtSubjectName));
    if (!sub) {
      targetBatch.subjects.push({ name: tgtSubjectName, chapters: [] });
      sub = targetBatch.subjects[targetBatch.subjects.length - 1];
      createdSubject = true;
    }
    // New chapters are appended in the source's chapter order (plans are already
    // sorted that way), so an empty target subject ends up in the same order.
    const maxOrder = sub.chapters.reduce((m, c) => Math.max(m, c.order || 0), -1);
    let nextOrder = maxOrder + 1;
    for (const p of plans) {
      if (!p.tgtIsNew) continue;
      sub.chapters.push({ name: p.tgtName, order: nextOrder++ });
      createdChapters.push(p.tgtName);
    }
    if (createdSubject || createdChapters.length) {
      await targetBatch.save();
      invalidateContentAccessCache();
    }

    const srcLabel = ch => `Imported from ${source.batch} / ${source.subject} / ${ch}`;

    // 2) Notes (concepts) — ids assigned up front so related links and
    // exercise conceptIds can be remapped to the new copies.
    const idMap = new Map(existing.conceptIdByImported.entries()); // source concept id -> target concept _id
    if (types.includes('notes')) {
      for (const p of plans) for (const c of p.items.notes) idMap.set(String(c._id), new mongoose.Types.ObjectId());
      const docs = [];
      for (const p of plans) {
        let idx = 0;
        for (const c of p.items.notes) {
          idx++;
          const d = { ...c };
          d._id = idMap.get(String(c._id));
          d.chapterId = p.tgtChapterId;
          d.aiContext = { ...(c.aiContext || {}), subject: tgtSubjectName, chapter: p.tgtName };
          if (standardNum != null) d.aiContext.standard = standardNum;
          d.status = asDraft ? 'draft' : c.status;
          if (d.status === 'published') d.publishedAt = c.publishedAt || now; else delete d.publishedAt;
          d.order = p.existingMaxOrder + (c.order || idx);
          d.createdBy = 'import';
          d.lastModifiedBy = adminId;
          d.versions = [{ versionNumber: 1, createdBy: adminId, createdAt: now, changes: srcLabel(p.srcName) }];
          delete d.analytics;
          d.relatedConceptIds = (c.relatedConceptIds || []).map(id => idMap.get(String(id))).filter(Boolean).map(String);
          d.created_at = now;
          d.updated_at = now;
          d.importedFrom = { id: String(c._id), batch: source.batch };
          Object.assign(d, tag);
          docs.push(d);
        }
      }
      results.notes.created = await insertChunks(Concept, docs);
    }

    // 3) Exercises
    if (types.includes('exercises')) {
      const docs = [];
      for (const p of plans) for (const q of p.items.exercises) {
        const d = { ...q };
        delete d._id;
        d.chapterId = p.tgtChapterId;
        d.subjectId = tgtSubjectName;
        d.batchId = target.batch;
        const mapped = q.conceptId ? idMap.get(String(q.conceptId)) : null;
        d.conceptId = mapped ? String(mapped) : '';
        d.usageCount = 0;
        d.usedInPapers = [];
        d.averageStudentScore = 0;
        d.totalAttempts = 0;
        d.correctAttempts = 0;
        d.status = asDraft ? 'draft' : q.status;
        d.createdBy = 'import';
        d.lastModifiedBy = adminId;
        d.created_at = now;
        d.updated_at = now;
        d.importedFrom = { id: String(q._id), batch: source.batch };
        Object.assign(d, tag);
        docs.push(d);
      }
      results.exercises.created = await insertChunks(SLSQuestion, docs);
    }

    // 4) MCQ question bank
    if (types.includes('mcq')) {
      const docs = [];
      for (const p of plans) for (const q of p.items.mcq) {
        const d = { ...q };
        delete d._id; delete d.created_at; delete d.updated_at;
        d.q_id = `q_${randomUUID()}`;
        d.batch = target.batch;
        d.subject = tgtSubjectName;
        d.chapter = p.tgtName;
        d.importedFrom = { id: q.q_id, batch: source.batch };
        Object.assign(d, tag);
        docs.push(d);
      }
      results.mcq.created = await insertChunks(Question, docs);
    }

    // 5) Tests (single-chapter only; mixed/multi-chapter tests are skipped)
    if (types.includes('quizzes')) {
      const docs = [];
      for (const p of plans) for (const q of p.items.quizzes) {
        const d = { ...q };
        delete d._id;
        d.quiz_id = `quiz_${randomUUID()}`;
        d.batch = target.batch;
        d.subject = tgtSubjectName;
        d.chapter = p.tgtName;
        d.status = asDraft ? 'draft' : q.status;
        d.version = 1;
        d.created_at = now;
        d.updated_at = now;
        if (q.sections) {
          d.sections = q.sections.map(s => ({
            ...s,
            source_batch: s.source_batch ? target.batch : s.source_batch,
            subject: s.subject ? tgtSubjectName : s.subject,
            chapter: s.chapter ? p.tgtName : s.chapter,
          }));
        }
        d.importedFrom = { id: q.quiz_id, batch: source.batch };
        Object.assign(d, tag);
        docs.push(d);
      }
      results.quizzes.created = await insertChunks(Quiz, docs);
    }

    // 6) PDF notes — the copy points at the SAME stored file (no re-upload)
    if (types.includes('pdf')) {
      const docs = [];
      for (const p of plans) for (const n of p.items.pdf) {
        const d = { ...n };
        delete d._id;
        d.note_id = randomUUID();
        d.batch = target.batch;
        d.subject = tgtSubjectName;
        d.chapter = p.tgtName;
        d.view_count = 0;
        d.created_by = adminId;
        d.created_at = now;
        d.importedFrom = { id: n.note_id, batch: source.batch };
        Object.assign(d, tag);
        docs.push(d);
      }
      results.pdf.created = await insertChunks(Note, docs);
    }

    for (const t of TYPES) results[t].skipped = plans.reduce((sum, p) => sum + p.counts[t].duplicate, 0);
    job.results = { ...results, mixed_quizzes_skipped: plans.reduce((s, p) => s + p.mixedSkipped, 0) };
    job.created_subject = createdSubject;
    job.created_chapters = createdChapters;
    await job.save();

    res.status(201).json({
      success: true,
      data: {
        job_id: jobId,
        target_subject: tgtSubjectName,
        results,
        mixed_quizzes_skipped: job.results.mixed_quizzes_skipped,
        chapters_created: createdChapters,
        subject_created: createdSubject,
      },
    });
  } catch (err) {
    job.results = { ...results, error: err.message };
    job.created_subject = createdSubject;
    job.created_chapters = createdChapters;
    await job.save().catch(() => {});
    // Partial copies are still tagged with the job id, so Undo can clean them up.
    return res.status(500).json({ success: false, message: `Import failed: ${err.message}. You can undo this import (job ${jobId}).`, job_id: jobId });
  }
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────
exports.listJobs = asyncHandler(async (_req, res) => {
  const jobs = await ImportJob.find().sort({ created_at: -1 }).limit(20).lean();
  res.json({
    success: true,
    data: jobs.map(j => ({
      job_id: j.job_id, created_at: j.created_at, source: j.source, target: j.target,
      types: j.types, as_draft: j.as_draft, results: j.results, undone: j.undone,
    })),
  });
});

// ── POST /undo { job_id } ─────────────────────────────────────────────────────
exports.undo = asyncHandler(async (req, res) => {
  const jobId = str(req.body?.job_id);
  const job = await ImportJob.findOne({ job_id: jobId });
  if (!job) throw new AppError('Import job not found', 404);
  if (job.undone) throw new AppError('This import was already undone', 400);

  const filter = { importJobId: jobId };
  const [c, s, q, z, n] = await Promise.all([
    Concept.deleteMany(filter),
    SLSQuestion.deleteMany(filter),
    Question.deleteMany(filter),
    Quiz.deleteMany(filter),
    // PDF copies share the original file, so only the database rows go — the
    // stored file is never touched here.
    Note.deleteMany(filter),
  ]);

  // Remove catalog entries this job created, if nothing else lives in them.
  const tBatch = job.target.batch;
  const tSubject = job.target.subject;
  const batchDoc = await Batch.findOne({ name: tBatch });
  let catalogRemoved = [];
  if (batchDoc) {
    const sub = batchDoc.subjects.find(x => slug(x.name) === slug(tSubject));
    if (sub) {
      for (const name of job.created_chapters || []) {
        const idRx = makeChapterId(tBatch, tSubject, name);
        const [k1, k2, k3, k4, k5] = await Promise.all([
          Concept.countDocuments({ chapterId: idRx }),
          SLSQuestion.countDocuments({ chapterId: idRx }),
          Question.countDocuments({ batch: looseRx(tBatch), subject: looseRx(tSubject), chapter: looseRx(name) }),
          Quiz.countDocuments({ batch: looseRx(tBatch), subject: looseRx(tSubject), chapter: looseRx(name) }),
          Note.countDocuments({ batch: looseRx(tBatch), subject: looseRx(tSubject), chapter: looseRx(name) }),
        ]);
        if (k1 + k2 + k3 + k4 + k5 === 0) {
          sub.chapters = sub.chapters.filter(ch => ch.name !== name);
          catalogRemoved.push(name);
        }
      }
      if (job.created_subject && sub.chapters.length === 0) {
        batchDoc.subjects = batchDoc.subjects.filter(x => x !== sub);
        catalogRemoved.push(`(subject) ${tSubject}`);
      }
      if (catalogRemoved.length) {
        await batchDoc.save();
        invalidateContentAccessCache();
      }
    }
  }

  job.undone = true;
  job.undone_at = new Date();
  await job.save();

  res.json({
    success: true,
    data: {
      deleted: { notes: c.deletedCount, exercises: s.deletedCount, mcq: q.deletedCount, quizzes: z.deletedCount, pdf: n.deletedCount },
      catalog_removed: catalogRemoved,
    },
  });
});
