const { v2: cloudinary } = require('cloudinary');
const Note         = require('../models/Note');
const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../utils/AppError');

function _iregex(s) {
  return { $regex: new RegExp('^' + String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') };
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Admin ────────────────────────────────────────────────────────────────────

// POST /api/admin/notes/upload
// body: { title, batch, subject, data: "data:application/pdf;base64,..." }
exports.uploadNote = asyncHandler(async (req, res) => {
  const { title, batch, subject, chapter, data } = req.body;
  if (!title)   throw new AppError('title is required', 400);
  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);
  if (!data || !data.startsWith('data:application/pdf;base64,'))
    throw new AppError('Valid PDF data (base64) is required', 400);
  if (!process.env.CLOUDINARY_CLOUD_NAME)
    throw new AppError('Cloudinary not configured', 500);

  // Estimate file size from base64 length  (base64 is ~4/3 of original)
  const base64Part    = data.split(',')[1] || '';
  const fileSizeBytes = Math.floor(base64Part.length * 0.75);
  if (fileSizeBytes > 10 * 1024 * 1024)
    throw new AppError('PDF too large — max 10 MB', 400);

  const result = await cloudinary.uploader.upload(data, {
    resource_type: 'raw',
    folder:        'teachingboard/notes',
    format:        'pdf',
  });

  const note = await Note.create({
    title:                title.trim(),
    batch:                batch.trim(),
    subject:              subject.trim(),
    chapter:              (chapter || '').trim(),
    cloudinary_url:       result.secure_url,
    cloudinary_public_id: result.public_id,
    file_size_bytes:      fileSizeBytes,
    created_by:           req.user?.id || 'admin',
  });

  res.status(201).json({ success: true, note_id: note.note_id, title: note.title });
});

// GET /api/admin/notes?batch=&subject=
exports.listNotesAdmin = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.batch)   filter.batch   = req.query.batch;
  if (req.query.subject) filter.subject = req.query.subject;
  if (req.query.chapter) filter.chapter = req.query.chapter;

  const notes = await Note.find(filter)
    .sort({ created_at: -1 })
    .select('-cloudinary_url')
    .lean();

  res.json({ success: true, notes });
});

// PUT /api/admin/notes/:id
exports.updateNote = asyncHandler(async (req, res) => {
  const { title, batch, subject, chapter } = req.body;
  if (!title)   throw new AppError('title is required', 400);
  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const note = await Note.findOne({ note_id: req.params.id });
  if (!note) throw new AppError('Note not found', 404);

  note.title   = title.trim();
  note.batch   = batch.trim();
  note.subject = subject.trim();
  note.chapter = (chapter || '').trim();
  await note.save();

  res.json({ success: true, note_id: note.note_id });
});

// DELETE /api/admin/notes/:id
exports.deleteNote = asyncHandler(async (req, res) => {
  const note = await Note.findOne({ note_id: req.params.id });
  if (!note) throw new AppError('Note not found', 404);

  try {
    await cloudinary.uploader.destroy(note.cloudinary_public_id, { resource_type: 'raw' });
  } catch (_) { /* Cloudinary delete failed — still remove from DB */ }

  await note.deleteOne();
  res.json({ success: true });
});

// ── Student ──────────────────────────────────────────────────────────────────

// GET /api/notes?batch=&subject=
// Returns metadata only — cloudinary_url NEVER included
exports.listNotesStudent = asyncHandler(async (req, res) => {
  const filter = { status: 'active' };
  if (req.query.batch)   filter.batch   = _iregex(req.query.batch);
  if (req.query.subject) filter.subject = _iregex(req.query.subject);

  const notes = await Note.find(filter)
    .sort({ created_at: -1 })
    .select('note_id title batch subject file_size_bytes view_count created_at')
    .lean();

  res.json({ success: true, notes });
});

// GET /api/notes/:id/view
// Batch-gated backend proxy — streams PDF binary; cloudinary_url never exposed
exports.viewNoteStudent = asyncHandler(async (req, res) => {
  const note = await Note.findOne({ note_id: req.params.id, status: 'active' });
  if (!note) throw new AppError('Note not found', 404);

  // Batch gate: student can only view notes for their own assigned batches
  const assignedBatches = Array.isArray(req.userDoc?.assigned_batches) ? req.userDoc.assigned_batches : [];
  const noteBatchLower  = (note.batch || '').toLowerCase();
  if (assignedBatches.length > 0 && !assignedBatches.some(b => b.toLowerCase() === noteBatchLower))
    throw new AppError('Access denied — this note is not for your batch', 403);

  // Increment view count (non-blocking, ignore errors)
  Note.updateOne({ note_id: req.params.id }, { $inc: { view_count: 1 } }).catch(() => {});

  // Fetch PDF from Cloudinary on the server side — URL never leaves the server
  let pdfResp;
  try {
    pdfResp = await fetch(note.cloudinary_url);
  } catch (e) {
    throw new AppError('Could not fetch PDF from storage', 502);
  }
  if (!pdfResp.ok) throw new AppError('PDF not available', 502);

  res.setHeader('Content-Type',            'application/pdf');
  res.setHeader('Content-Disposition',     'inline');
  res.setHeader('Cache-Control',           'private, no-store');
  res.setHeader('X-Content-Type-Options',  'nosniff');

  // Stream PDF binary to student
  const reader = pdfResp.body.getReader();
  const pump   = async () => {
    const { done, value } = await reader.read();
    if (done) { res.end(); return; }
    res.write(Buffer.from(value));
    await pump();
  };
  await pump();
});
