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
      difficulty, boardFrequency, questionDiagrams, answerDiagrams
    } = req.body;

    // Validate required fields
    if (!conceptId || !chapterId || !marks || !questionType) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: conceptId, chapterId, marks, questionType'
      });
    }

    if (![1, 2, 3, 4, 5].includes(marks)) {
      return res.status(400).json({
        success: false,
        message: 'Marks must be 1, 2, 3, 4, or 5'
      });
    }

    const question = new SLSQuestion({
      conceptId,
      chapterId,
      subjectId,
      batchId,
      questionText,
      answerText,
      marks,
      questionType,
      difficulty,
      boardFrequency,
      questionDiagrams: questionDiagrams || [],
      answerDiagrams: answerDiagrams || [],
      status: 'draft',
      createdBy: req.user?.id || 'system'
    });

    await question.save();

    // Update ConceptMarks
    await updateConceptMarksQuestionCount(conceptId, marks, 1);

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
      difficulty, boardFrequency, status = 'published',
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

    const skip = (page - 1) * limit;

    const questions = await SLSQuestion.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ created_at: -1 });

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
    const updates = req.body;

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
    await updateConceptMarksQuestionCount(question.conceptId, question.marks, -1);

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

    if (!chapterId || !totalMarks) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: chapterId, totalMarks'
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

    // Calculate marks distribution
    const distribution = calculateMarksDistribution(totalMarks);
    const selectedQuestions = [];
    let currentMarks = 0;

    // For each marks value in distribution, select questions
    for (const [marks, count] of Object.entries(distribution)) {
      const marksNum = parseInt(marks);

      for (let i = 0; i < count; i++) {
        // Select random concept weighted by conceptWeight
        const concept = selectWeightedConcept(concepts);

        // Get unused question of this marks from this concept
        const question = await SLSQuestion.findOne({
          conceptId: concept.conceptId,
          marks: marksNum,
          status: 'published',
          _id: { $nin: selectedQuestions.map(q => q.questionId) }
        })
        .sort({ usageCount: 1 }) // Prefer less used questions
        .lean();

        if (question) {
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

    // Verify marks match
    if (currentMarks !== totalMarks) {
      return res.status(400).json({
        success: false,
        message: `Could not generate paper with exact ${totalMarks} marks. Generated: ${currentMarks}`
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

// Get Papers
exports.getPapers = async (req, res) => {
  try {
    const { chapterId, batchId, status = 'published', page = 1, limit = 20 } = req.query;

    const filter = {};
    if (chapterId) filter.chapterId = chapterId;
    if (batchId) filter.batchId = batchId;
    if (status) filter.status = status;

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
    const { studentId, studentCode, answers } = req.body;

    if (!paperId || !studentId || !answers) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const paper = await PracticePaper.findById(paperId);
    if (!paper) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found'
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
    if (studentId) filter.studentId = studentId;
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

    // Update answers with marks
    let totalMarksAwarded = 0;
    let correctCount = 0;
    let partialCount = 0;

    const updatedAnswers = attempt.answers.map(existingAnswer => {
      const evaluatedAnswer = answers.find(a => a.questionId === existingAnswer.questionId.toString());

      if (evaluatedAnswer) {
        const marksAwarded = evaluatedAnswer.marksAwarded || 0;
        totalMarksAwarded += marksAwarded;

        if (marksAwarded === existingAnswer.maxMarks) correctCount++;
        else if (marksAwarded > 0) partialCount++;

        return {
          ...existingAnswer,
          marksAwarded,
          feedback: evaluatedAnswer.feedback || '',
          isCorrect: marksAwarded === existingAnswer.maxMarks,
          evaluatedAt: new Date(),
          evaluatedBy: req.user?.id || 'system'
        };
      }
      return existingAnswer;
    });

    // Calculate percentage and grade
    const percentage = Math.round((totalMarksAwarded / attempt.totalMarks) * 100);
    const grade = calculateGrade(percentage);

    // Get question details for performance analysis
    const questionIds = updatedAnswers.map(a => a.questionId);
    const questions = await SLSQuestion.find({ _id: { $in: questionIds } }).lean();
    const questionsMap = {};
    questions.forEach(q => {
      questionsMap[q._id.toString()] = q;
    });

    // Identify weak and strong areas
    const { weakAreas, strongAreas } = analyzePerformance(updatedAnswers, questionsMap);

    attempt.answers = updatedAnswers;
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
  // Smart distribution algorithm
  // For 20 marks: {1: 4, 2: 4, 3: 2, 5: 1} = 4+8+6+5 = 23 (too high)
  // Better: {1: 2, 2: 3, 3: 2, 5: 1} = 2+6+6+5 = 19
  // Or: {1: 0, 2: 4, 3: 2, 5: 1} = 8+6+5 = 19
  // Better: {1: 1, 2: 3, 3: 3, 5: 1} = 1+6+9+5 = 21 (close)
  // Best: {1: 2, 2: 2, 3: 3, 5: 1} = 2+4+9+5 = 20 ✓

  const distributions = {
    10: { 1: 2, 2: 2, 3: 1 },
    15: { 1: 1, 2: 2, 3: 3, 5: 0 },
    20: { 1: 2, 2: 2, 3: 3, 5: 1 },
    25: { 1: 0, 2: 3, 3: 2, 5: 2 },
    30: { 1: 0, 2: 0, 3: 4, 5: 2 }
  };

  return distributions[totalMarks] || { 1: 2, 2: 2, 3: 2, 5: 1 };
}

function selectWeightedConcept(concepts) {
  // Weight-based random selection
  const totalWeight = concepts.reduce((sum, c) => sum + (c.conceptWeight || 1), 0);
  let random = Math.random() * totalWeight;

  for (const concept of concepts) {
    random -= (concept.conceptWeight || 1);
    if (random <= 0) return concept;
  }

  return concepts[0];
}

async function updateConceptMarksQuestionCount(conceptId, marks, delta) {
  const concept = await ConceptMarks.findOne({ conceptId });

  if (concept) {
    concept.questionsByMarks[marks] = (concept.questionsByMarks[marks] || 0) + delta;
    concept.updated_at = new Date();
    await concept.save();
  } else if (delta > 0) {
    await ConceptMarks.create({
      conceptId,
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
