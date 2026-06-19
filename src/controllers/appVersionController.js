const AppVersion = require('../models/AppVersion');

function _genVersionId() {
  return 'VER' + Date.now().toString(36).toUpperCase().slice(-6);
}

// GET /api/app-version/latest — public, no auth
async function getLatestVersion(req, res, next) {
  try {
    const latest = await AppVersion.findOne({ is_latest: true }).lean();
    if (!latest) return res.json({ version: null });
    res.json({
      version:       latest.version,
      apk_url:       latest.apk_url,
      release_notes: latest.release_notes,
      platform:      latest.platform,
      released_at:   latest.created_at,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/app-version — admin only
async function getAllVersions(req, res, next) {
  try {
    const versions = await AppVersion.find({}).sort({ created_at: -1 }).lean();
    res.json(versions);
  } catch (err) {
    next(err);
  }
}

// POST /api/app-version — admin only
async function createVersion(req, res, next) {
  try {
    const { version, apk_url, release_notes, platform, activate } = req.body;
    if (!version || !String(version).trim()) {
      return res.status(400).json({ message: 'version is required' });
    }

    if (activate) {
      await AppVersion.updateMany({}, { is_latest: false });
    }

    const record = await AppVersion.create({
      version_id:    _genVersionId(),
      version:       String(version).trim(),
      apk_url:       String(apk_url || '').trim(),
      release_notes: String(release_notes || '').trim(),
      platform:      ['android', 'web', 'all'].includes(platform) ? platform : 'android',
      is_latest:     !!activate,
    });

    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/app-version/:id/activate — admin only
async function activateVersion(req, res, next) {
  try {
    const { id } = req.params;
    const record = await AppVersion.findOne({ version_id: id }).lean();
    if (!record) return res.status(404).json({ message: 'Version not found' });

    await AppVersion.updateMany({}, { is_latest: false });
    await AppVersion.updateOne({ version_id: id }, { is_latest: true });

    res.json({ ok: true, latest: id });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/app-version/:id — admin only
async function deleteVersion(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await AppVersion.findOneAndDelete({ version_id: id });
    if (!deleted) return res.status(404).json({ message: 'Version not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getLatestVersion, getAllVersions, createVersion, activateVersion, deleteVersion };
