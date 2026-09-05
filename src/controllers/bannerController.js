const Banner       = require('../models/Banner');
const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../utils/AppError');

function _norm(s) { return String(s || '').trim().toLowerCase(); }

// ── Admin ────────────────────────────────────────────────────────────────────

// GET /api/admin/banners
exports.listBannersAdmin = asyncHandler(async (req, res) => {
  const banners = await Banner.find({}).sort({ order: 1, created_at: -1 }).lean();
  res.json({ success: true, banners });
});

// POST /api/admin/banners
// body: { imageUrl?, title, subtitle?, linkType?, linkValue?, scope, batchNames?, order?, active? }
exports.createBanner = asyncHandler(async (req, res) => {
  const { imageUrl, title, subtitle, linkType, linkValue, scope, batchNames, order, active } = req.body;
  if (!title || !String(title).trim()) throw new AppError('title is required', 400);
  if (scope === 'batches' && (!Array.isArray(batchNames) || batchNames.length === 0))
    throw new AppError('batchNames is required when scope is "batches"', 400);

  const banner = await Banner.create({
    imageUrl:   (imageUrl || '').trim(),
    title:      title.trim(),
    subtitle:   (subtitle || '').trim(),
    linkType:   ['none', 'batch', 'subject', 'url'].includes(linkType) ? linkType : 'none',
    linkValue:  (linkValue || '').trim(),
    scope:      scope === 'batches' ? 'batches' : 'all',
    batchNames: scope === 'batches' ? batchNames.map(b => String(b || '').trim()).filter(Boolean) : [],
    order:      Number.isFinite(Number(order)) ? Number(order) : 0,
    active:     active === undefined ? true : !!active,
    created_by: req.user?.id || req.user?.name || 'admin',
  });

  res.status(201).json({ success: true, banner_id: banner.banner_id });
});

// PUT /api/admin/banners/:id
exports.updateBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findOne({ banner_id: req.params.id });
  if (!banner) throw new AppError('Banner not found', 404);

  const { imageUrl, title, subtitle, linkType, linkValue, scope, batchNames, order, active } = req.body;
  if (title !== undefined) {
    if (!String(title).trim()) throw new AppError('title cannot be empty', 400);
    banner.title = title.trim();
  }
  if (imageUrl   !== undefined) banner.imageUrl  = (imageUrl || '').trim();
  if (subtitle   !== undefined) banner.subtitle  = (subtitle || '').trim();
  if (linkType   !== undefined) banner.linkType  = ['none', 'batch', 'subject', 'url'].includes(linkType) ? linkType : 'none';
  if (linkValue  !== undefined) banner.linkValue = (linkValue || '').trim();
  if (order      !== undefined) banner.order     = Number.isFinite(Number(order)) ? Number(order) : banner.order;
  if (active     !== undefined) banner.active    = !!active;
  if (scope !== undefined) {
    if (scope === 'batches') {
      if (!Array.isArray(batchNames) || batchNames.length === 0)
        throw new AppError('batchNames is required when scope is "batches"', 400);
      banner.scope      = 'batches';
      banner.batchNames = batchNames.map(b => String(b || '').trim()).filter(Boolean);
    } else {
      banner.scope      = 'all';
      banner.batchNames = [];
    }
  }

  await banner.save();
  res.json({ success: true, banner_id: banner.banner_id });
});

// DELETE /api/admin/banners/:id
exports.deleteBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findOne({ banner_id: req.params.id });
  if (!banner) throw new AppError('Banner not found', 404);
  await banner.deleteOne();
  res.json({ success: true });
});

// ── Student ──────────────────────────────────────────────────────────────────

// GET /api/banners/for-student
// Own assigned batch(es) + every 'all'-scope banner. Never trusts a
// client-supplied batch — same principle as noteController's batch gate.
exports.getBannersForStudent = asyncHandler(async (req, res) => {
  const assignedBatches = Array.isArray(req.userDoc?.assigned_batches)
    ? req.userDoc.assigned_batches.map(_norm).filter(Boolean)
    : [];

  const all = await Banner.find({ active: true }).sort({ order: 1, created_at: -1 }).lean();
  const scoped = all.filter(b => {
    if (b.scope === 'all') return true;
    if (!Array.isArray(b.batchNames)) return false;
    return b.batchNames.some(n => assignedBatches.includes(_norm(n)));
  });

  res.json({
    success: true,
    banners: scoped.map(b => ({
      banner_id: b.banner_id,
      imageUrl:  b.imageUrl,
      title:     b.title,
      subtitle:  b.subtitle,
      linkType:  b.linkType,
      linkValue: b.linkValue,
    })),
  });
});

// POST /api/banners/:id/open — fire-and-forget engagement counter
exports.recordBannerOpen = asyncHandler(async (req, res) => {
  await Banner.updateOne({ banner_id: req.params.id }, { $inc: { openCount: 1 } });
  res.json({ success: true });
});
