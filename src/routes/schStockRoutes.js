// 📚 /api/sch-stock — admin-only stock for the scholarship question generator (see models/SchStock.js)
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { SchStockBatch, SchStockItem } = require('../models/SchStock');

const router = express.Router();
const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
const EXAM = /^[a-z0-9_-]{1,20}$/i, KIND = /^[A-Za-z0-9_]{2,40}$/;
const MAX_ITEMS = 3000, MAX_ENTRY = 20000;

function view(b) { return { id: String(b._id), name: b.name, source: b.source, status: b.status, count: b.count, created_at: b.created_at }; }

// GET /api/sch-stock?exam=4 → every batch and item of that exam
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const exam = str(req.query.exam, 20) || '4';
  if (!EXAM.test(exam)) throw new AppError('exam चुकीचा', 400);
  const [batches, items] = await Promise.all([
    SchStockBatch.find({ exam }).sort({ created_at: -1 }).lean(),
    SchStockItem.find({ exam }).sort({ created_at: 1 }).lean(),
  ]);
  res.json({ success: true, data: {
    batches: batches.map(view),
    items: items.map(i => ({ id: String(i._id), kind: i.kind, entry: i.entry, norm: i.norm, batch_id: String(i.batch_id) })),
  } });
}));

// POST /api/sch-stock/batch { exam, name, source, status, items:[{kind, entry, norm}] }
// Entries already saved (same exam + kind + norm) are skipped, never saved twice.
router.post('/batch', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {}, exam = str(b.exam, 20) || '4';
  if (!EXAM.test(exam)) throw new AppError('exam चुकीचा', 400);
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) throw new AppError('साठवण्यासारखे काहीच नाही', 400);
  if (raw.length > MAX_ITEMS) throw new AppError(`एका वेळी जास्तीत जास्त ${MAX_ITEMS} नोंदी`, 400);
  const seen = new Set(), items = [];
  for (const it of raw) {
    const kind = str(it?.kind, 40), norm = str(it?.norm, 600);
    if (!KIND.test(kind) || !norm || it.entry == null) throw new AppError('नोंद चुकीची आहे', 400);
    if (JSON.stringify(it.entry).length > MAX_ENTRY) throw new AppError('एक नोंद खूप मोठी आहे', 400);
    const k = kind + '\u0000' + norm; if (seen.has(k)) continue; seen.add(k);
    items.push({ kind, norm, entry: it.entry });
  }
  const already = new Set((await SchStockItem.find({ exam, $or: items.map(i => ({ kind: i.kind, norm: i.norm })) }, { kind: 1, norm: 1 }).lean()).map(i => i.kind + '\u0000' + i.norm));
  const fresh = items.filter(i => !already.has(i.kind + '\u0000' + i.norm));
  if (!fresh.length) return res.json({ success: true, data: { batch: null, saved: 0, skipped: items.length } });
  const batch = await SchStockBatch.create({ exam, name: str(b.name) || 'साठा', source: str(b.source, 40), status: b.status === 'review' ? 'review' : 'live', count: 0, created_by: str(req.user?.user_id || req.user?.id, 60) });
  let saved = 0;
  try {
    const r = await SchStockItem.insertMany(fresh.map(i => ({ ...i, exam, batch_id: batch._id })), { ordered: false });
    saved = r.length;
  } catch (e) {   // a duplicate saved at the same moment by another tab: keep the rest
    saved = e?.insertedDocs?.length ?? e?.result?.insertedCount ?? 0;
    if (!e?.writeErrors && e?.code !== 11000) { await SchStockBatch.deleteOne({ _id: batch._id }); throw e; }
  }
  if (!saved) { await SchStockBatch.deleteOne({ _id: batch._id }); return res.json({ success: true, data: { batch: null, saved: 0, skipped: items.length } }); }
  batch.count = saved; await batch.save();
  const mine = await SchStockItem.find({ batch_id: batch._id }).lean();
  res.json({ success: true, data: { batch: view(batch), saved, skipped: items.length - saved,
    items: mine.map(i => ({ id: String(i._id), kind: i.kind, entry: i.entry, norm: i.norm, batch_id: String(i.batch_id) })) } });
}));

// PATCH /api/sch-stock/batch/:id { status: 'live' | 'review' }
router.patch('/batch/:id', requireAdmin, asyncHandler(async (req, res) => {
  const status = req.body?.status === 'review' ? 'review' : 'live';
  const b = await SchStockBatch.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true }).lean().catch(() => null);
  if (!b) throw new AppError('Batch सापडला नाही', 404);
  res.json({ success: true, data: view(b) });
}));

// DELETE /api/sch-stock/batch/:id — the batch and all its entries
router.delete('/batch/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = await SchStockBatch.findById(req.params.id).catch(() => null);
  if (!b) throw new AppError('Batch सापडला नाही', 404);
  const r = await SchStockItem.deleteMany({ batch_id: b._id });
  await b.deleteOne();
  res.json({ success: true, data: { removed: r.deletedCount || 0 } });
}));

// DELETE /api/sch-stock/item/:id — one entry
router.delete('/item/:id', requireAdmin, asyncHandler(async (req, res) => {
  const it = await SchStockItem.findByIdAndDelete(req.params.id).catch(() => null);
  if (!it) throw new AppError('नोंद सापडली नाही', 404);
  const left = await SchStockItem.countDocuments({ batch_id: it.batch_id });
  if (left) await SchStockBatch.updateOne({ _id: it.batch_id }, { $set: { count: left } });
  else await SchStockBatch.deleteOne({ _id: it.batch_id });
  res.json({ success: true, data: { batch_left: left } });
}));

module.exports = router;
