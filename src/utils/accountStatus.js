function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeExpiryDate(expiryDate) {
  if (!expiryDate) return "";

  if (expiryDate instanceof Date) {
    return expiryDate.toISOString().slice(0, 10);
  }

  return String(expiryDate).slice(0, 10);
}

function isExpiredDate(expiryDate) {
  const normalized = normalizeExpiryDate(expiryDate);
  if (!normalized) return false;
  return normalized < getTodayIsoDate();
}

module.exports = {
  getTodayIsoDate,
  normalizeExpiryDate,
  isExpiredDate
};
