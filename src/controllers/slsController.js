const SLSQuestion = require('../models/SLSQuestion');
const PracticePaper = require('../models/PracticePaper');
const StudentPaperAttempt = require('../models/StudentPaperAttempt');
const ConceptMarks = require('../models/ConceptMarks');
const Concept = require('../models/Concept');

/**
 * ═══════════════════════════════════════════════════════════
 * QUESTION MANAGEMENT ENDPOINTS
 * ═══════════════════════════════════════════════════════════
 */

// Create Question
exports.createQuestion = async (req, res) => {
  try {
    const {
      conceptId, chapterId, subjectId, batchId,
      questionText, answerText, marks, questionType,
      difficulty, boardFrequency, questionDiagrams, answerDiagrams, status
    } = req.body;

    // Validate required fields (must match SLSQuestion model's required paths)
    if (!conceptId || !chapterId || !subjectId || !batchId || !marks || !questionType || !difficulty) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: conceptId, chapterId, subjectId, batchId, marks, questionType, difficulty'
      });
    }

    if (!questionText?.english || !answerText?.english) {
      return res.status(400).json({
        success: false,
        message: 'questionText.english and answerText.english are required'
      });
    }

    if (![1, 2, 3, 4, 5].includes(Number(marks))) {
      return res.status(400).json({
        success: false,
        message: 'Marks must be 1, 2, 3, 4, or 5'
      });
    }

    const marksNum = Number(marks);
    const question = new SLSQuestion({
      conceptId,
      chapterId,
      subjectId,
      batchId,
      questionText,
      answerText,
      marks: marksNum,
      questionType,
      difficulty,
      boardFrequency,
      questionDiagrams: questionDiagrams || [],
      answerDiagrams: answerDiagrams || [],
      status: ['draft', 'published', 'archived'].includes(status) ? status : 'draft',
      createdBy: req.user?.id || 'system'
    });

    await question.save();

    // Update ConceptMarks
    await updateConceptMarksQuestionCount(conceptId, marksNum, 1, { chapterId, batchId });

    res.status(201).json({
      success: true,
      message: 'Question created successfully',
      data: question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get Questions with Filters
exports.getQuestions = async (req, res) => {
  try {
    const {
      conceptId, chapterId, batchId, marks, questionType,
      difficulty, boardFrequency, status = 'published', q,
      page = 1, limit = 20
    } = req.query;

    const filter = {};
    if (conceptId) filter.conceptId = conceptId;
    if (chapterId) filter.chapterId = chapterId;
    if (batchId) filter.batchId = batchId;
    if (marks) filter.marks = parseInt(marks);
    if (questionType) filter.questionType = questionType;
    if (difficulty) filter.difficulty = difficulty;
    if (boardFrequency) filter.boardFrequency = boardFrequency;
    if (status) filter.status = status;
    if (q && q.trim()) {
      const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { 'questionText.english': re },
        { 'questionText.marathi': re },
        { 'answerText.english': re },
        { 'answerText.marathi': re }
      ];
    }

    const skip = (page - 1) * limit;

    const sortBy = req.query.sort === 'usageCount' ? { usageCount: 1 } : { created_at: -1 };
    const questions = await SLSQuestion.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort(sortBy);

    const total = await SLSQuestion.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: questions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Update Question
exports.updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;

    // Whitelist updatable fields — model is strict:'throw', so unknown keys
    // would otherwise crash; this also blocks mass-assignment of internal fields.
    const ALLOWED = [
      'conceptId', 'chapterId', 'subjectId', 'batchId',
      'questionText', 'answerText', 'marks', 'questionType',
      'difficulty', 'boardFrequency', 'questionDiagrams', 'answerDiagrams', 'status'
    ];
    const updates = {};
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.marks !== undefined) updates.marks = Number(updates.marks);

    const question = await SLSQuestion.findByIdAndUpdate(
      id,
      {
        ...updates,
        updated_at: new Date(),
        lastModifiedBy: req.user?.id || 'system'
      },
      { new: true, runValidators: true }
    );

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      data: question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Delete Question
exports.deleteQuestion = async (req, res) => {
  try {
    const { id } = req.params;

    const question = await SLSQuestion.findByIdAndDelete(id);

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Update ConceptMarks
    await updateConceptMarksQuestionCount(question.conceptId, question.marks, -1, {
      chapterId: question.chapterId,
      batchId: question.batchId
    });

    res.status(200).json({
      success: true,
      message: 'Question deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Publish Question
exports.publishQuestion = async (req, res) => {
  try {
    const { id } = req.params;

    const question = await SLSQuestion.findByIdAndUpdate(
      id,
      { status: 'published', updated_at: new Date() },
      { new: true }
    );

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Question published successfully',
      data: question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * ═══════════════════════════════════════════════════════════
 * PRACTICE PAPER GENERATION & MANAGEMENT
 * ═══════════════════════════════════════════════════════════
 */

// Smart Paper Generation Algorithm
exports.generatePaper = async (req, res) => {
  try {
    const {
      chapterId, batchId, subjectId,
      totalMarks = 20,
      difficulty = 'mixed',
      questionTypes = [],
      boardFrequency = [],
      paperTitle
    } = req.body;

    if (!chapterId || !totalMarks || !subjectId || !batchId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: chapterId, subjectId, batchId, totalMarks'
      });
    }

    // Get all concepts in chapter with marks assigned
    const concepts = await ConceptMarks.find({
      chapterId,
      assignedMarks: { $exists: true, $ne: [] }
    });

    if (concepts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No concepts with assigned marks found in this chapter'
      });
    }

    // Calculate marks distribution (guaranteed to sum to totalMarks)
    const distribution = calculateMarksDistribution(totalMarks);
    const selectedQuestions = [];
    const selectedIds = [];
    let currentMarks = 0;

    // For each marks value in distribution, select questions chapter-wide
    // (any concept) so a single concept lacking a question doesn't fail the slot.
    for (const [marks, count] of Object.entries(distribution)) {
      const marksNum = parseInt(marks);

      for (let i = 0; i < count; i++) {
        const question = await SLSQuestion.findOne({
          chapterId,
          marks: marksNum,
          status: 'published',
          _id: { $nin: selectedIds }
        })
        .sort({ usageCount: 1 }) // Prefer less used questions
        .lean();

        if (question) {
          selectedIds.push(question._id);
          selectedQuestions.push({
            questionId: question._id,
            marks: marksNum,
            difficulty: question.difficulty,
            questionType: question.questionType,
            displayOrder: selectedQuestions.length + 1,
            totalAttempts: 0,
            correctAttempts: 0,
            averageScore: 0
          });
          currentMarks += marksNum;
        }
      }
    }

    // Verify marks match — if short, it's an inventory problem, report clearly
    if (currentMarks !== totalMarks) {
      return res.status(400).json({
        success: false,
        message: `Not enough published questions to reach ${totalMarks} marks (built ${currentMarks}). Add more questions for this chapter and try again.`
      });
    }

    // Get next paper number
    const lastPaper = await PracticePaper.findOne({ chapterId })
      .sort({ paperNumber: -1 })
      .lean();

    const paperNumber = (lastPaper?.paperNumber || 0) + 1;

    // Create paper
    const paper = new PracticePaper({
      chapterId,
      batchId,
      subjectId,
      paperNumber,
      paperTitle: paperTitle || `Practice Paper ${paperNumber}`,
      totalMarks,
      totalQuestions: selectedQuestions.length,
      questions: selectedQuestions,
      marksBreakdown: Object.entries(distribution).map(([marks, count]) => ({
        marks: parseInt(marks),
        count,
        totalMarksForThisValue: parseInt(marks) * count
      })),
      generationFilters: {
        difficulty,
        questionTypes,
        boardFrequency
      },
      status: 'draft',
      createdBy: req.user?.id || 'system',
      generatedAt: new Date()
    });

    await paper.save();

    // Update question usage
    for (const q of selectedQuestions) {
      await SLSQuestion.findByIdAndUpdate(
        q.questionId,
        {
          $inc: { usageCount: 1 },
          $push: {
            usedInPapers: {
              paperId: paper._id,
              usedDate: new Date()
            }
          }
        }
      );
    }

    res.status(201).json({
      success: true,
      message: 'Paper generated successfully',
      data: paper
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Create Paper Manually (teacher/admin hand-picks questions, no auto-distribution)
exports.createPaperManual = async (req, res) => {
  try {
    const { batchId, chapterId, subjectId, paperTitle, questions } = req.body;

    if (!batchId || !chapterId || !subjectId || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: batchId, chapterId, subjectId, questions[]'
      });
    }

    const ids = questions.map(q => q.questionId);
    const found = await SLSQuestion.find({ _id: { $in: ids } }).lean();
    const foundMap = new Map(found.map(q => [q._id.toString(), q]));

    const selectedQuestions = [];
    let totalMarks = 0;
    let order = 0;
    for (const item of questions) {
      const src = foundMap.get(String(item.questionId));
      if (!src) {
        return res.status(400).json({ success: false, message: `Question ${item.questionId} not found` });
      }
      // Defense-in-depth: manually-picked questions must belong to the same
      // batch/chapter as the paper, mirroring the isolation guarantees the
      // rest of this app enforces (a client could otherwise hand-pick a
      // questionId from a different batch's chapter).
      if (src.batchId !== batchId || src.chapterId !== chapterId) {
        return res.status(400).json({ success: false, message: `Question ${item.questionId} does not belong to this batch/chapter` });
      }
      order += 1;
      selectedQuestions.push({
        questionId: src._id,
        marks: src.marks,
        difficulty: src.difficulty,
        questionType: src.questionType,
        displayOrder: order,
        totalAttempts: 0,
        correctAttempts: 0,
        averageScore: 0
      });
      totalMarks += src.marks;
    }

    const lastPaper = await PracticePaper.findOne({ chapterId })
      .sort({ paperNumber: -1 })
      .lean();
    const paperNumber = (lastPaper?.paperNumber || 0) + 1;

    const marksTally = {};
    for (const sq of selectedQuestions) marksTally[sq.marks] = (marksTally[sq.marks] || 0) + 1;

    const paper = new PracticePaper({
      chapterId,
      batchId,
      subjectId,
      paperNumber,
      paperTitle: paperTitle || `Practice Paper ${paperNumber}`,
      totalMarks,
      totalQuestions: selectedQuestions.length,
      questions: selectedQuestions,
      marksBreakdown: Object.entries(marksTally).map(([marks, count]) => ({
        marks: parseInt(marks),
        count,
        totalMarksForThisValue: parseInt(marks) * count
      })),
      status: 'draft',
      createdBy: req.user?.id || 'system',
      generatedAt: new Date()
    });

    await paper.save();

    // Same usage-tracking bookkeeping generatePaper() does.
    for (const sq of selectedQuestions) {
      await SLSQuestion.findByIdAndUpdate(
        sq.questionId,
        {
          $inc: { usageCount: 1 },
          $push: { usedInPapers: { paperId: paper._id, usedDate: new Date() } }
        }
      );
    }

    res.status(201).json({
      success: true,
      message: 'Paper created successfully',
      data: paper
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get Papers
exports.getPapers = async (req, res) => {
  try {
    const { chapterId, batchId, status = 'published', page = 1, limit = 20 } = req.query;

    const filter = {};
    if (chapterId) filter.chapterId = chapterId;
    if (status) filter.status = status;

    // Admins (and the internal callers of this shared function) see
    // whatever batchId they ask for, or everything if they don't specify
    // one. Students previously got the same untrusted behavior — omitting
    // batchId returned every batch's published papers, and supplying
    // another batch's name/id worked too. Force students to their own
    // assigned_batches regardless of what they send.
    if (req.user?.role === 'student') {
      const assigned = Array.isArray(req.userDoc?.assigned_batches) ? req.userDoc.assigned_batches : [];
      filter.batchId = { $in: assigned };
    } else if (batchId) {
      filter.batchId = batchId;
    }

    const skip = (page - 1) * limit;

    const papers = await PracticePaper.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ created_at: -1 });

    const total = await PracticePaper.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: papers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get Paper with Questions
exports.getPaperWithQuestions = async (req, res) => {
  try {
    const { id } = req.params;

    const paper = await PracticePaper.findById(id);

    if (!paper) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found'
      });
    }

    if (req.user?.role === 'student') {
      const assigned = Array.isArray(req.userDoc?.assigned_batches) ? req.userDoc.assigned_batches : [];
      if (!assigned.includes(paper.batchId)) {
        return res.status(403).json({ success: false, message: 'Not available for your batch' });
      }
    }

    // Get all questions for this paper
    const questionIds = paper.questions.map(q => q.questionId);
    const questions = await SLSQuestion.find({ _id: { $in: questionIds } }).lean();

    // Map questions to paper questions maintaining order
    const questionsWithDetails = paper.questions.map(pq => {
      const fullQuestion = questions.find(q => q._id.toString() === pq.questionId.toString());
      return {
        ...pq.toObject(),
        questionText: fullQuestion?.questionText,
        questionDiagrams: fullQuestion?.questionDiagrams,
        answerText: fullQuestion?.answerText,
        answerDiagrams: fullQuestion?.answerDiagrams
      };
    });

    res.status(200).json({
      success: true,
      data: {
        ...paper.toObject(),
        questions: questionsWithDetails
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Publish Paper
exports.publishPaper = async (req, res) => {
  try {
    const { id } = req.params;

    const paper = await PracticePaper.findByIdAndUpdate(
      id,
      { status: 'published', updated_at: new Date() },
      { new: true }
    );

    if (!paper) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Paper published successfully',
      data: paper
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * ═══════════════════════════════════════════════════════════
 * STUDENT PAPER ATTEMPT MANAGEMENT
 * ═══════════════════════════════════════════════════════════
 */

// Submit Answers
exports.submitAnswers = async (req, res) => {
  try {
    const { paperId } = req.params;
    const { answers } = req.body;

    // Identity comes from the authenticated session — never trust the body.
    const studentId = req.user?.id;
    const studentCode = req.userDoc?.student_code || '';

    if (!paperId || !studentId || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: answers (array)'
      });
    }

    const paper = await PracticePaper.findById(paperId);
    if (!paper) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found'
      });
    }

    if (paper.status !== 'published') {
      return res.status(403).json({
        success: false,
        message: 'This paper is not available'
      });
    }

    const assignedBatches = Array.isArray(req.userDoc?.assigned_batches) ? req.userDoc.assigned_batches : [];
    if (!assignedBatches.includes(paper.batchId)) {
      return res.status(403).json({ success: false, message: 'Not available for your batch' });
    }

    // getStudentAttempts lists every past attempt (repeat practice is
    // legitimate), so this can't block resubmission outright — but a
    // network retry of the exact same submit within a few seconds is not a
    // real repeat attempt, just a duplicate write. This is the largest
    // per-document attempt type in the app (embeds full answers/diagrams),
    // so a duplicate here costs the most storage of any attempt model.
    const DUPLICATE_WINDOW_MS = 15_000;
    const recentDuplicate = await StudentPaperAttempt.findOne({
      paperId, studentId,
      created_at: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    }).sort({ created_at: -1 });
    if (recentDuplicate) {
      return res.status(200).json({
        success: true, message: 'Answers submitted successfully',
        data: recentDuplicate, already_submitted: true,
      });
    }

    // Create attempt
    const attempt = new StudentPaperAttempt({
      paperId,
      studentId,
      studentCode,
      batchId: paper.batchId,
      totalMarks: paper.totalMarks,
      totalQuestions: paper.totalQuestions,
      answers: answers.map(a => ({
        questionId: a.questionId,
        marks: a.marks,
        studentAnswer: a.answer || {},
        maxMarks: a.marks
      })),
      status: 'submitted',
      attemptStartTime: new Date(req.body.startTime || Date.now()),
      attemptEndTime: new Date(),
      questionsAttempted: answers.filter(a => a.answer?.text).length
    });

    await attempt.save();

    res.status(201).json({
      success: true,
      message: 'Answers submitted successfully',
      data: attempt
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get Student Attempts
exports.getStudentAttempts = async (req, res) => {
  try {
    const { studentId, paperId, status, page = 1, limit = 20 } = req.query;

    const filter = {};
    // Students may only ever see their OWN attempts; admins can filter freely.
    if (req.user?.role === 'student') {
      filter.studentId = req.user.id;
    } else if (studentId) {
      filter.studentId = studentId;
    }
    if (paperId) filter.paperId = paperId;
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const attempts = await StudentPaperAttempt.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ created_at: -1 });

    const total = await StudentPaperAttempt.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: attempts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get Attempt Details
exports.getAttemptDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const attempt = await StudentPaperAttempt.findById(id);

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: 'Attempt not found'
      });
    }

    // Students may only view their own attempt
    if (req.user?.role === 'student' && attempt.studentId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get full question details for each answer
    const questionIds = attempt.answers.map(a => a.questionId);
    const questions = await SLSQuestion.find({ _id: { $in: questionIds } }).lean();

    const answersWithDetails = attempt.answers.map(ans => {
      const fullQuestion = questions.find(q => q._id.toString() === ans.questionId.toString());
      return {
        ...ans.toObject(),
        questionText: fullQuestion?.questionText,
        modelAnswerText: fullQuestion?.answerText,
        modelAnswerDiagrams: fullQuestion?.answerDiagrams
      };
    });

    res.status(200).json({
      success: true,
      data: {
        ...attempt.toObject(),
        answers: answersWithDetails
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Evaluate Attempt (Teacher marking)
exports.evaluateAttempt = async (req, res) => {
  try {
    const { id } = req.params;
    const { answers, evaluationNotes } = req.body;

    const attempt = await StudentPaperAttempt.findById(id);

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: 'Attempt not found'
      });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: 'answers array is required'
      });
    }

    // Update answers with marks — mutate the Mongoose subdocuments in place.
    // (Spreading a subdoc loses its data fields and breaks the save.)
    let totalMarksAwarded = 0;
    let correctCount = 0;
    let partialCount = 0;

    attempt.answers.forEach(existingAnswer => {
      const evaluatedAnswer = answers.find(a => a.questionId === existingAnswer.questionId.toString());
      if (!evaluatedAnswer) return;

      const maxMarks = existingAnswer.maxMarks || 0;
      // Clamp awarded marks to [0, maxMarks]
      let marksAwarded = Number(evaluatedAnswer.marksAwarded) || 0;
      marksAwarded = Math.max(0, Math.min(marksAwarded, maxMarks));
      totalMarksAwarded += marksAwarded;

      const isFull = maxMarks > 0 && marksAwarded === maxMarks;
      if (isFull) correctCount++;
      else if (marksAwarded > 0) partialCount++;

      existingAnswer.marksAwarded = marksAwarded;
      existingAnswer.feedback = evaluatedAnswer.feedback || '';
      existingAnswer.isCorrect = isFull;
      existingAnswer.evaluatedAt = new Date();
      existingAnswer.evaluatedBy = req.user?.id || 'system';
    });

    // Calculate percentage and grade (guard divide-by-zero)
    const percentage = attempt.totalMarks > 0
      ? Math.round((totalMarksAwarded / attempt.totalMarks) * 100)
      : 0;
    const grade = calculateGrade(percentage);

    // Get question details for performance analysis
    const questionIds = attempt.answers.map(a => a.questionId);
    const questions = await SLSQuestion.find({ _id: { $in: questionIds } }).lean();
    const questionsMap = {};
    questions.forEach(q => {
      questionsMap[q._id.toString()] = q;
    });

    // Identify weak and strong areas
    const { weakAreas, strongAreas } = analyzePerformance(attempt.answers, questionsMap);

    attempt.totalMarksObtained = totalMarksAwarded;
    attempt.percentage = percentage;
    attempt.grade = grade;
    attempt.correctAnswers = correctCount;
    attempt.partialAnswers = partialCount;
    attempt.status = 'evaluated';
    attempt.evaluatedBy = req.user?.id || 'system';
    attempt.evaluatedAt = new Date();
    attempt.evaluationNotes = evaluationNotes || '';
    attempt.weakAreas = weakAreas;
    attempt.strongAreas = strongAreas;

    await attempt.save();

    res.status(200).json({
      success: true,
      message: 'Attempt evaluated successfully',
      data: attempt
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * ═══════════════════════════════════════════════════════════
 * HELPER FUNCTIONS
 * ═══════════════════════════════════════════════════════════
 */

function calculateMarksDistribution(totalMarks) {
  // Build a mixed distribution that ALWAYS sums exactly to totalMarks.
  // Roughly 40% from 5-mark, then 3-mark, then 2-mark, and 1-mark absorbs
  // any remainder so the total is exact for any positive integer total.
  const total = Math.max(0, parseInt(totalMarks) || 0);
  const dist = { 1: 0, 2: 0, 3: 0, 5: 0 };
  let remaining = total;

  dist[5] = Math.floor((remaining * 0.4) / 5);
  remaining -= dist[5] * 5;

  dist[3] = Math.floor((remaining * 0.5) / 3);
  remaining -= dist[3] * 3;

  dist[2] = Math.floor(remaining / 2);
  remaining -= dist[2] * 2;

  dist[1] = remaining; // exact remainder → guarantees sum === total

  return dist;
}

async function updateConceptMarksQuestionCount(conceptId, marks, delta, context = {}) {
  const concept = await ConceptMarks.findOne({ conceptId });

  if (concept) {
    const current = concept.questionsByMarks?.[marks] || 0;
    concept.questionsByMarks[marks] = Math.max(0, current + delta);
    concept.markModified('questionsByMarks'); // nested map change isn't auto-tracked
    if (delta > 0 && !concept.assignedMarks.includes(marks)) {
      concept.assignedMarks.push(marks); // keep assignedMarks in sync
    }
    concept.updated_at = new Date();
    await concept.save();
  } else if (delta > 0) {
    // chapterId & batchId are required on ConceptMarks — must pass them
    if (!context.chapterId || !context.batchId) return;
    await ConceptMarks.create({
      conceptId,
      chapterId: context.chapterId,
      batchId: context.batchId,
      assignedMarks: [marks],
      questionsByMarks: { [marks]: 1 }
    });
  }
}

function calculateGrade(percentage) {
  if (percentage >= 90) return 'A+';
  if (percentage >= 85) return 'A';
  if (percentage >= 80) return 'B+';
  if (percentage >= 75) return 'B';
  if (percentage >= 70) return 'C+';
  if (percentage >= 60) return 'C';
  if (percentage >= 50) return 'D';
  return 'F';
}

function analyzePerformance(answers, questionsMap = {}) {
  const typePerformance = {};

  answers.forEach(ans => {
    const question = questionsMap[ans.questionId.toString()] || {};
    const type = question.questionType || 'unknown';
    if (!typePerformance[type]) {
      typePerformance[type] = { total: 0, awarded: 0, count: 0 };
    }
    typePerformance[type].total += ans.maxMarks || 0;
    typePerformance[type].awarded += ans.marksAwarded || 0;
    typePerformance[type].count++;
  });

  const weakAreas = [];
  const strongAreas = [];

  for (const [type, perf] of Object.entries(typePerformance)) {
    if (perf.total <= 0) continue; // avoid NaN
    const percentage = (perf.awarded / perf.total) * 100;
    if (percentage < 60) {
      weakAreas.push({ type, category: type, performancePercentage: percentage });
    } else if (percentage >= 80) {
      strongAreas.push({ type, category: type, performancePercentage: percentage });
    }
  }

  return { weakAreas, strongAreas };
}

module.exports = exports;
