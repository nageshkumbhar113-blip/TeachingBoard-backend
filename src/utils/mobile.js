// Basic Indian mobile sanity: 10 digits, starts 6-9, not all-same.
function isValidMobile(mobile) {
  const m = String(mobile || '').trim();
  if (!/^\d{10}$/.test(m)) return false;
  if (/^(\d)\1{9}$/.test(m)) return false;
  if (parseInt(m[0], 10) < 6) return false;
  return true;
}

module.exports = { isValidMobile };
