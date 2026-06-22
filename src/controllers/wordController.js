const { randomUUID }   = require('crypto');
const Word             = require('../models/Word');
const VocabAttempt     = require('../models/VocabAttempt');
const User             = require('../models/User');
const asyncHandler     = require('../utils/asyncHandler');
const AppError         = require('../utils/AppError');
const { sendToMany }   = require('../utils/fcm');

const WORDS_PER_TEST = 20;
const PASS_PCT       = 0.60;

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _nextSeqNum(batch, subject) {
  const last = await Word.findOne({ batch, subject })
    .sort({ seq_num: -1 })
    .select('seq_num')
    .lean();
  return (last?.seq_num || 0) + 1;
}

function _sanitizeWord(w) {
  return {
    word:          String(w.word          || '').trim(),
    batch:         String(w.batch         || '').trim(),
    subject:       String(w.subject       || '').trim(),
    meaning_mr:    String(w.meaning_mr    || '').trim(),
    meaning_en:    String(w.meaning_en    || '').trim(),
    pronunciation: String(w.pronunciation || '').trim(),
    phonics:       String(w.phonics       || '').trim(),
    image_url:     String(w.image_url     || '').trim(),
    difficulty:    ['easy', 'medium', 'hard'].includes(w.difficulty) ? w.difficulty : 'medium',
    tags:          Array.isArray(w.tags) ? w.tags.map(t => String(t).trim()).filter(Boolean) : [],
    added_by:      w.added_by === 'student' ? 'student' : 'admin',
    added_by_code: String(w.added_by_code || '').trim(),
  };
}

// ─── Admin: Word Bank ─────────────────────────────────────────────────────────

// GET /api/admin/words
exports.listWords = asyncHandler(async (req, res) => {
  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();
  const search  = String(req.query.search  || '').trim();
  const limit   = Math.min(Math.max(parseInt(req.query.limit)  || 50, 1), 200);
  const skip    = Math.max(parseInt(req.query.skip) || 0, 0);

  const filter = {};
  if (batch)   filter.batch   = batch;
  if (subject) filter.subject = subject;
  if (search) {
    filter.$or = [
      { word:       { $regex: search, $options: 'i' } },
      { meaning_mr: { $regex: search, $options: 'i' } },
      { meaning_en: { $regex: search, $options: 'i' } },
    ];
  }

  const [words, total] = await Promise.all([
    Word.find(filter).sort({ batch: 1, subject: 1, seq_num: 1 }).skip(skip).limit(limit).lean(),
    Word.countDocuments(filter),
  ]);

  res.json({ success: true, total, count: words.length, data: words });
});

// POST /api/admin/words
exports.createWord = asyncHandler(async (req, res) => {
  const data = _sanitizeWord(req.body);
  if (!data.word)    throw new AppError('word is required', 400);
  if (!data.batch)   throw new AppError('batch is required', 400);
  if (!data.subject) throw new AppError('subject is required', 400);

  const seq_num = await _nextSeqNum(data.batch, data.subject);
  const word = await Word.create({ word_id: randomUUID(), ...data, seq_num });

  res.status(201).json({ success: true, data: word });
});

// PATCH /api/admin/words/:id
exports.updateWord = asyncHandler(async (req, res) => {
  const wordId = String(req.params.id || '').trim();
  if (!wordId) throw new AppError('word id required', 400);

  const allow = ['word', 'meaning_mr', 'meaning_en', 'pronunciation', 'phonics',
                  'image_url', 'difficulty', 'tags'];
  const update = {};
  for (const key of allow) {
    if (req.body[key] !== undefined) {
      update[key] = key === 'tags'
        ? (Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t).trim()).filter(Boolean) : [])
        : String(req.body[key]).trim();
    }
  }

  const word = await Word.findOneAndUpdate(
    { word_id: wordId },
    { $set: update },
    { new: true }
  ).lean();

  if (!word) throw new AppError('Word not found', 404);
  res.json({ success: true, data: word });
});

// DELETE /api/admin/words/:id
exports.deleteWord = asyncHandler(async (req, res) => {
  const wordId = String(req.params.id || '').trim();
  if (!wordId) throw new AppError('word id required', 400);

  const word = await Word.findOneAndDelete({ word_id: wordId }).lean();
  if (!word) throw new AppError('Word not found', 404);

  res.json({ success: true, message: 'Word deleted' });
});

// POST /api/admin/words/bulk
exports.bulkCreateWords = asyncHandler(async (req, res) => {
  const items = req.body.words;
  if (!Array.isArray(items) || !items.length) {
    throw new AppError('words array is required', 400);
  }

  // Group by batch+subject to assign seq_nums efficiently
  const groups = {};
  for (const w of items) {
    const key = `${String(w.batch || '').trim()}|${String(w.subject || '').trim()}`;
    if (!groups[key]) groups[key] = { batch: String(w.batch || '').trim(), subject: String(w.subject || '').trim(), items: [] };
    groups[key].items.push(w);
  }

  const toInsert = [];
  for (const key of Object.keys(groups)) {
    const { batch, subject, items: groupItems } = groups[key];
    if (!batch || !subject) throw new AppError(`batch and subject required for all words`, 400);

    let nextSeq = await _nextSeqNum(batch, subject);
    for (const w of groupItems) {
      const data = _sanitizeWord({ ...w, batch, subject });
      if (!data.word) throw new AppError('word text is required for all items', 400);
      toInsert.push({ word_id: randomUUID(), ...data, seq_num: nextSeq++ });
    }
  }

  const inserted = await Word.insertMany(toInsert, { ordered: false });
  res.status(201).json({ success: true, inserted: inserted.length });
});

// POST /api/admin/words/auto-fill  OR  GET /api/vocab/auto-fill?word=X
exports.autoFillWord = asyncHandler(async (req, res) => {
  const word = String(req.body.word || req.query.word || '').trim();
  if (!word) throw new AppError('word is required', 400);

  const enc = encodeURIComponent(word);
  const result = { word, pronunciation: '', phonics: '', meaning_en: '', meaning_mr: '' };

  // Free Dictionary API — pronunciation + English definition
  try {
    const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (dictRes.ok) {
      const data = await dictRes.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (entry) {
        const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
        const phonText  = phonetics.find(p => p.text)?.text || entry.phonetic || '';
        result.pronunciation = phonText;
        result.phonics       = phonText;

        const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
        const firstDef = meanings[0]?.definitions?.[0]?.definition || '';
        result.meaning_en = firstDef;
      }
    }
  } catch (_) { /* network error — skip */ }

  // MyMemory API — English to Marathi translation
  try {
    const transRes = await fetch(
      `https://api.mymemory.translated.net/get?q=${enc}&langpair=en|mr`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (transRes.ok) {
      const data = await transRes.json();
      const translated = data?.responseData?.translatedText || '';
      if (translated && translated.toLowerCase() !== word.toLowerCase()) {
        result.meaning_mr = translated;
      }
    }
  } catch (_) { /* network error — skip */ }

  res.json({ success: true, data: result });
});

// ─── Student: Vocab Tests ─────────────────────────────────────────────────────

// GET /api/vocab/subjects?batch=X  — subjects that have at least 1 word
exports.getVocabSubjects = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '').trim();
  if (!batch) throw new AppError('batch is required', 400);
  const subjects = await Word.distinct('subject', { batch, subject: { $nin: ['', null] } });
  res.json({ success: true, subjects: subjects.sort() });
});

// GET /api/vocab/test-list?batch=X&subject=Y
exports.getTestList = asyncHandler(async (req, res) => {
  const studentDoc  = req.userDoc;
  const batch       = String(req.query.batch   || studentDoc?.assigned_batches?.[0] || '').trim();
  const subject     = String(req.query.subject || '').trim();

  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const studentCode = normalizeCode(studentDoc?.student_code || '');

  const totalWords = await Word.countDocuments({ batch, subject });
  const totalTests = Math.ceil(totalWords / WORDS_PER_TEST);

  // Fetch student's attempts for this batch+subject
  const attempts = await VocabAttempt.find({ student_code: studentCode, batch, subject })
    .sort({ submitted_at: -1 })
    .lean();

  // Build a map: test_num → best attempt
  const attemptMap = {};
  for (const a of attempts) {
    if (!attemptMap[a.test_num]) attemptMap[a.test_num] = a;
  }

  const tests = [];
  for (let i = 1; i <= totalTests; i++) {
    const wFrom = (i - 1) * WORDS_PER_TEST + 1;
    const wTo   = Math.min(i * WORDS_PER_TEST, totalWords);
    const att   = attemptMap[i];
    tests.push({
      test_num:   i,
      word_from:  wFrom,
      word_to:    wTo,
      word_count: wTo - wFrom + 1,
      attempted:  !!att,
      passed:     att?.passed ?? null,
      total_score: att?.total_score ?? null,
      total_possible: att?.total_possible ?? null,
      score_listen:   att?.score_listen   ?? null,
      score_meaning:  att?.score_meaning  ?? null,
      score_picture:  att?.score_picture  ?? null,
      score_spelling: att?.score_spelling ?? null,
    });
  }

  res.json({ success: true, batch, subject, total_words: totalWords, total_tests: totalTests, tests });
});

// GET /api/vocab/test/:num?batch=X&subject=Y&meaning_lang=marathi
exports.getTest = asyncHandler(async (req, res) => {
  const testNum     = parseInt(req.params.num);
  const batch       = String(req.query.batch   || '').trim();
  const subject     = String(req.query.subject || '').trim();
  const meaningLang = req.query.meaning_lang === 'english' ? 'english' : 'marathi';

  if (!testNum || testNum < 1) throw new AppError('Invalid test number', 400);
  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const wFrom = (testNum - 1) * WORDS_PER_TEST + 1;
  const wTo   = testNum * WORDS_PER_TEST;

  const words = await Word.find({ batch, subject, seq_num: { $gte: wFrom, $lte: wTo } })
    .sort({ seq_num: 1 })
    .lean();

  if (!words.length) throw new AppError('No words found for this test', 404);

  // Return word data only — frontend handles question rendering
  const wordData = words.map(w => ({
    word_id:       w.word_id,
    word:          w.word,
    meaning_mr:    w.meaning_mr,
    meaning_en:    w.meaning_en,
    pronunciation: w.pronunciation,
    phonics:       w.phonics,
    image_url:     w.image_url,
    seq_num:       w.seq_num,
    // Active meaning based on student preference
    meaning:       meaningLang === 'english' ? w.meaning_en : w.meaning_mr,
  }));

  res.json({
    success:      true,
    test_num:     testNum,
    word_from:    wFrom,
    word_to:      Math.min(wTo, wFrom + words.length - 1),
    meaning_lang: meaningLang,
    word_count:   wordData.length,
    words:        wordData,
  });
});

// POST /api/vocab/attempt
exports.submitAttempt = asyncHandler(async (req, res) => {
  const studentDoc = req.userDoc;
  if (!studentDoc) throw new AppError('Student not found', 404);

  const studentCode = normalizeCode(studentDoc.student_code || '');
  const studentName = String(studentDoc.name || '').trim();
  const batch       = String(req.body.batch   || '').trim();
  const subject     = String(req.body.subject || '').trim();
  const testNum     = parseInt(req.body.test_num);
  const meaningLang = req.body.meaning_lang === 'english' ? 'english' : 'marathi';

  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);
  if (!testNum || testNum < 1) throw new AppError('test_num is required', 400);

  // Scores per section (0..N)
  const scoreListen   = Math.max(0, parseInt(req.body.score_listen)   || 0);
  const scoreMeaning  = Math.max(0, parseInt(req.body.score_meaning)  || 0);
  const scorePicture  = Math.max(0, parseInt(req.body.score_picture)  || 0);
  const scoreSpelling = Math.max(0, parseInt(req.body.score_spelling) || 0);
  const totalPossible = Math.max(1, parseInt(req.body.total_possible) || WORDS_PER_TEST * 4);

  const wFrom      = (testNum - 1) * WORDS_PER_TEST + 1;
  const totalWords = await Word.countDocuments({ batch, subject });
  const wTo        = Math.min(testNum * WORDS_PER_TEST, totalWords);

  const totalScore = scoreListen + scoreMeaning + scorePicture + scoreSpelling;
  const passed     = totalScore / totalPossible >= PASS_PCT;

  const attempt = await VocabAttempt.create({
    attempt_id:     randomUUID(),
    student_code:   studentCode,
    student_name:   studentName,
    batch,
    subject,
    test_num:       testNum,
    word_from:      wFrom,
    word_to:        wTo,
    meaning_lang:   meaningLang,
    score_listen:   scoreListen,
    score_meaning:  scoreMeaning,
    score_picture:  scorePicture,
    score_spelling: scoreSpelling,
    total_score:    totalScore,
    total_possible: totalPossible,
    passed,
    submitted_at:   new Date(),
  });

  // FCM: notify teacher + parent
  _notifyVocabComplete(studentCode, studentName, batch, subject, testNum, totalScore, totalPossible).catch(
    err => console.warn('Vocab FCM error:', err.message)
  );

  res.status(201).json({ success: true, passed, total_score: totalScore, total_possible: totalPossible, data: attempt });
});

async function _notifyVocabComplete(studentCode, studentName, batch, subject, testNum, totalScore, totalPossible) {
  const pct   = Math.round((totalScore / totalPossible) * 100);
  const title = `Vocabulary Test ${testNum} Complete`;
  const body  = `${studentName} — ${totalScore}/${totalPossible} (${pct}%) | ${batch} ${subject}`;
  const data  = { type: 'vocab', student_code: studentCode, test_num: String(testNum), batch, subject };

  // Teachers who have this student assigned
  const teachers = await User.find({
    role:              'teacher',
    assigned_students: studentCode,
    device_token:      { $exists: true, $nin: [null, ''] },
  }).select('device_token').lean();

  // Parent linked to this student
  const parents = await User.find({
    role:         'parent',
    children:     studentCode,
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('device_token').lean();

  const tokens = [...new Set(
    [...teachers, ...parents].map(u => u.device_token).filter(Boolean)
  )];

  if (tokens.length) {
    await sendToMany(tokens, title, body, data);
  }
}

// POST /api/student/words  (student adds unknown word to shared bank)
exports.addStudentWord = asyncHandler(async (req, res) => {
  const studentDoc  = req.userDoc;
  const studentCode = normalizeCode(studentDoc?.student_code || '');
  const batch       = String(req.body.batch   || studentDoc?.assigned_batches?.[0] || '').trim();
  const subject     = String(req.body.subject || '').trim();

  const data = _sanitizeWord({
    ...req.body,
    batch,
    subject,
    added_by:      'student',
    added_by_code: studentCode,
  });

  if (!data.word)    throw new AppError('word is required', 400);
  if (!data.batch)   throw new AppError('batch is required', 400);
  if (!data.subject) throw new AppError('subject is required', 400);

  // Avoid duplicate words in same batch+subject
  const exists = await Word.findOne({ batch, subject, word: { $regex: `^${data.word}$`, $options: 'i' } }).lean();
  if (exists) {
    return res.json({ success: true, message: 'Word already exists in bank', data: exists });
  }

  const seq_num = await _nextSeqNum(data.batch, data.subject);
  const word    = await Word.create({ word_id: randomUUID(), ...data, seq_num });

  res.status(201).json({ success: true, data: word });
});

// ─── Teacher: Vocab Scores ────────────────────────────────────────────────────

// GET /api/teacher/vocab-scores?batch=X&subject=Y
exports.getTeacherVocabScores = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc;
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();

  const assignedCodes = Array.isArray(teacherDoc.assigned_students)
    ? teacherDoc.assigned_students.filter(Boolean)
    : [];

  if (!assignedCodes.length) return res.json({ success: true, data: [] });

  const filter = { student_code: { $in: assignedCodes } };
  if (batch)   filter.batch   = batch;
  if (subject) filter.subject = subject;

  const attempts = await VocabAttempt.find(filter).lean();

  // Aggregate per student
  const studentMap = {};
  for (const a of attempts) {
    if (!studentMap[a.student_code]) {
      studentMap[a.student_code] = {
        student_code: a.student_code,
        student_name: a.student_name,
        tests_done: 0,
        listen_total: 0, listen_possible: 0,
        meaning_total: 0, meaning_possible: 0,
        picture_total: 0, picture_possible: 0,
        spelling_total: 0, spelling_possible: 0,
      };
    }
    const s = studentMap[a.student_code];
    s.tests_done++;
    const perSection = a.total_possible / 4;
    s.listen_total   += a.score_listen;   s.listen_possible   += perSection;
    s.meaning_total  += a.score_meaning;  s.meaning_possible  += perSection;
    s.picture_total  += a.score_picture;  s.picture_possible  += perSection;
    s.spelling_total += a.score_spelling; s.spelling_possible += perSection;
  }

  // Get total tests available
  const totalTests = batch && subject
    ? Math.ceil(await Word.countDocuments({ batch, subject }) / WORDS_PER_TEST)
    : null;

  // Fetch student names from User if needed
  const studentCodes = Object.keys(studentMap);
  if (studentCodes.length) {
    const users = await User.find({ student_code: { $in: studentCodes } })
      .select('student_code name').lean();
    for (const u of users) {
      if (studentMap[u.student_code]) studentMap[u.student_code].student_name = u.name || '';
    }
  }

  const data = Object.values(studentMap).map(s => ({
    student_code:    s.student_code,
    student_name:    s.student_name,
    tests_completed: s.tests_done,
    tests_available: totalTests,
    avg_listen:   s.listen_possible   ? Math.round((s.listen_total   / s.listen_possible)   * 100) : 0,
    avg_meaning:  s.meaning_possible  ? Math.round((s.meaning_total  / s.meaning_possible)  * 100) : 0,
    avg_picture:  s.picture_possible  ? Math.round((s.picture_total  / s.picture_possible)  * 100) : 0,
    avg_spelling: s.spelling_possible ? Math.round((s.spelling_total / s.spelling_possible) * 100) : 0,
  }));

  // Add students who have no attempts
  for (const code of assignedCodes) {
    if (!studentMap[code]) {
      const user = await User.findOne({ student_code: code }).select('name').lean();
      data.push({
        student_code: code,
        student_name: user?.name || '',
        tests_completed: 0,
        tests_available: totalTests,
        avg_listen: 0, avg_meaning: 0, avg_picture: 0, avg_spelling: 0,
      });
    }
  }

  data.sort((a, b) => a.student_name.localeCompare(b.student_name));

  res.json({ success: true, data });
});
