const { randomUUID } = require('crypto');
const Concept = require('../models/Concept');
const ConceptVersion = require('../models/ConceptVersion');
const StudentProgress = require('../models/StudentProgress');
const asyncHandler = require('../utils/asyncHandler');

// ════════════════════════════════════
// CREATE CONCEPT
// ════════════════════════════════════

exports.createConcept = asyncHandler(async (req, res) => {
  const {
    chapterId,
    language,
    title,
    learningOutcomes,
    description,
    shortNotes,
    revisionBox,
    examTags,
    difficulty,
    keywords,
    aiContext
  } = req.body;

  if (!chapterId || !title?.english) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: chapterId, title.english'
    });
  }

  if (!description?.english?.blocks) {
    return res.status(400).json({
      success: false,
      message: 'Missing required: description.english.blocks'
    });
  }

  if (!_validateEditorJSBlocks(description.english.blocks)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid English content blocks'
    });
  }

  if (language === 'bilingual' && description?.marathi?.blocks) {
    if (!_validateEditorJSBlocks(description.marathi.blocks)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Marathi content blocks'
      });
    }
  }

  const maxOrder = await Concept.findOne({ chapterId })
    .sort({ order: -1 })
    .select('order');
  const nextOrder = (maxOrder?.order || 0) + 1;

  const concept = await Concept.create({
    chapterId,
    language: language || 'english',
    title: {
      english: title.english,
      marathi: title.marathi || ''
    },
    learningOutcomes: {
      english: learningOutcomes?.english || [],
      marathi: learningOutcomes?.marathi || []
    },
    description: {
      english: {
        blocks: description.english.blocks,
        version: '2.0'
      },
      marathi: {
        blocks: description.marathi?.blocks || [],
        version: '2.0'
      }
    },
    shortNotes: {
      english: shortNotes?.english || [],
      marathi: shortNotes?.marathi || []
    },
    revisionBox: {
      english: {
        remember: revisionBox?.english?.remember || [],
        mistakes: revisionBox?.english?.mistakes || [],
        formulas: revisionBox?.english?.formulas || [],
        examTips: revisionBox?.english?.examTips || []
      },
      marathi: {
        remember: revisionBox?.marathi?.remember || [],
        mistakes: revisionBox?.marathi?.mistakes || [],
        formulas: revisionBox?.marathi?.formulas || [],
        examTips: revisionBox?.marathi?.examTips || []
      }
    },
    examTags: examTags || [],
    studyModes: {
      readMode: { content: 'description', showAttachments: true, showFormulas: true },
      examMode: { content: 'shortNotes', showAttachments: false, showFormulas: true },
      revisionMode: { content: 'revision', showAttachments: false, showFormulas: true, showRevisionBox: true }
    },
    aiContext: {
      board: aiContext?.board || 'CBSE',
      standard: aiContext?.standard ?? null,
      medium: aiContext?.medium || 'english',
      subject: aiContext?.subject || '',
      chapter: aiContext?.chapter || '',
      difficulty: difficulty || 'easy',
      keywords: keywords || []
    },
    order: nextOrder,
    status: 'draft',
    createdBy: req.user?.id || 'admin',
    versions: [{
      versionNumber: 1,
      createdBy: req.user?.id || 'admin',
      createdAt: new Date(),
      changes: 'Initial creation'
    }]
  });

  res.status(201).json({
    success: true,
    message: 'Concept created successfully',
    data: concept
  });
});

// ════════════════════════════════════
// GET SINGLE CONCEPT (for editing)
// ════════════════════════════════════

exports.getConcept = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;

  const concept = await Concept.findById(conceptId).lean();

  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  res.json({
    success: true,
    data: concept
  });
});

// ════════════════════════════════════
// GET CHAPTER CONCEPTS (List)
// ════════════════════════════════════

exports.getChapterConcepts = asyncHandler(async (req, res) => {
  const { chapterId } = req.params;
  const { status = 'published' } = req.query;

  const query = { chapterId };
  if (status) query.status = status;

  const concepts = await Concept.find(query)
    .sort({ order: 1 })
    .select('_id title order difficulty examTags analytics.totalViews status')
    .lean();

  res.json({
    success: true,
    data: {
      concepts,
      total: concepts.length
    }
  });
});

// ════════════════════════════════════
// LIST PUBLISHED CHAPTERS (student notes browser — distinct chapters
// that have at least one published concept)
// ════════════════════════════════════

exports.getPublishedChapters = asyncHandler(async (req, res) => {
  const chapters = await Concept.aggregate([
    { $match: { status: 'published' } },
    {
      $group: {
        _id: '$chapterId',
        standard: { $first: '$aiContext.standard' },
        subject: { $first: '$aiContext.subject' },
        chapter: { $first: '$aiContext.chapter' },
        conceptCount: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        chapterId: '$_id',
        standard: 1,
        subject: 1,
        chapter: 1,
        conceptCount: 1
      }
    },
    { $sort: { standard: 1, subject: 1, chapter: 1 } }
  ]);

  res.json({ success: true, data: chapters });
});

// ════════════════════════════════════
// UPDATE CONCEPT
// ════════════════════════════════════

exports.updateConcept = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;
  const { changesSummary } = req.body;

  // Whitelist updatable fields — model is strict:'throw', so unknown keys
  // would crash; this also blocks mass-assignment of internal fields.
  const ALLOWED = [
    'chapterId', 'language', 'title', 'learningOutcomes', 'description',
    'shortNotes', 'revisionBox', 'attachments', 'relatedConceptIds',
    'examTags', 'studyModes', 'aiContext', 'status', 'order'
  ];
  const updates = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const concept = await Concept.findById(conceptId);
  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  const newVersionNumber = (concept.versions?.length || 0) + 1;

  await ConceptVersion.create({
    conceptId,
    versionNumber: newVersionNumber,
    snapshot: concept.toObject(),
    changesSummary: changesSummary || 'Updated',
    changedBy: req.user?.id || 'admin'
  });

  const updateData = {
    ...updates,
    updated_at: new Date(),
    lastModifiedBy: req.user?.id || 'admin',
    $push: {
      versions: {
        versionNumber: newVersionNumber,
        createdBy: req.user?.id || 'admin',
        createdAt: new Date(),
        changes: changesSummary || 'Updated'
      }
    }
  };

  const updatedConcept = await Concept.findByIdAndUpdate(
    conceptId,
    updateData,
    { new: true, runValidators: false }
  );

  res.json({
    success: true,
    message: 'Concept updated successfully',
    data: updatedConcept
  });
});

// ════════════════════════════════════
// DELETE CONCEPT
// ════════════════════════════════════

exports.deleteConcept = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;

  const concept = await Concept.findByIdAndDelete(conceptId);
  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  await Promise.all([
    ConceptVersion.deleteMany({ conceptId }),
    StudentProgress.deleteMany({ conceptId })
  ]);

  res.json({
    success: true,
    message: 'Concept deleted successfully'
  });
});

// ════════════════════════════════════
// PUBLISH CONCEPT
// ════════════════════════════════════

exports.publishConcept = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;

  const concept = await Concept.findByIdAndUpdate(
    conceptId,
    {
      status: 'published',
      publishedAt: new Date()
    },
    { new: true }
  );

  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  res.json({
    success: true,
    message: 'Concept published successfully',
    data: concept
  });
});

// ════════════════════════════════════
// RESTORE VERSION
// ════════════════════════════════════

exports.restoreVersion = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;
  const { versionNumber } = req.body;

  const version = await ConceptVersion.findOne({
    conceptId,
    versionNumber
  });

  if (!version) {
    return res.status(404).json({
      success: false,
      message: 'Version not found'
    });
  }

  const concept = await Concept.findById(conceptId);
  const newVersionNumber = (concept.versions?.length || 0) + 1;

  await ConceptVersion.create({
    conceptId,
    versionNumber: newVersionNumber,
    snapshot: version.snapshot,
    changesSummary: `Restored from version ${versionNumber}`,
    changedBy: req.user?.id || 'admin'
  });

  // Strip immutable / conflicting fields from the snapshot:
  //  - _id is immutable
  //  - versions is also targeted by $push below (would conflict in one update)
  //  - created_at should be preserved, not overwritten
  const { _id, versions, created_at, __v, ...snapshotFields } = version.snapshot || {};

  const restored = await Concept.findByIdAndUpdate(
    conceptId,
    {
      ...snapshotFields,
      updated_at: new Date(),
      lastModifiedBy: req.user?.id || 'admin',
      $push: {
        versions: {
          versionNumber: newVersionNumber,
          createdBy: req.user?.id || 'admin',
          createdAt: new Date(),
          changes: `Restored from version ${versionNumber}`
        }
      }
    },
    { new: true }
  );

  res.json({
    success: true,
    message: `Concept restored to version ${versionNumber}`,
    data: restored
  });
});

// ════════════════════════════════════
// SEARCH CONCEPTS
// ════════════════════════════════════

exports.searchConcepts = asyncHandler(async (req, res) => {
  const { q, limit = 20 } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({
      success: false,
      message: 'Search query must be at least 2 characters'
    });
  }

  const results = await Concept.find(
    {
      $text: { $search: q },
      status: 'published'
    },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(parseInt(limit))
    .select('title difficulty examTags')
    .lean();

  res.json({
    success: true,
    data: results,
    count: results.length
  });
});

// ════════════════════════════════════
// GET CONCEPT ANALYTICS
// ════════════════════════════════════

exports.getConceptAnalytics = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;

  const concept = await Concept.findById(conceptId)
    .select('title difficulty examTags analytics')
    .lean();

  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  res.json({
    success: true,
    data: {
      concept,
      analytics: concept.analytics
    }
  });
});

// ════════════════════════════════════
// AUTO-TRANSLATE CONTENT
// ════════════════════════════════════

exports.autoTranslateContent = asyncHandler(async (req, res) => {
  const { conceptId } = req.params;

  const concept = await Concept.findById(conceptId);
  if (!concept) {
    return res.status(404).json({
      success: false,
      message: 'Concept not found'
    });
  }

  concept.title.marathi = `[मराठी] ${concept.title.english}`;
  concept.language = 'bilingual';
  await concept.save();

  res.json({
    success: true,
    message: 'Content marked for Marathi translation',
    data: concept
  });
});

// ════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════

function _validateEditorJSBlocks(blocks) {
  if (!Array.isArray(blocks)) return false;

  const validTypes = [
    'paragraph', 'heading', 'image', 'table',
    'note_box', 'warning_box', 'formula', 'quote',
    'checklist', 'divider', 'callout'
  ];

  return blocks.every(block => {
    if (!block.type || !validTypes.includes(block.type)) return false;
    if (!block.data || typeof block.data !== 'object') return false;
    return true;
  });
}
