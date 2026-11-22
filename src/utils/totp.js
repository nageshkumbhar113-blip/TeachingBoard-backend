// Time-based one-time codes (RFC 6238) — the 6-digit code Google Authenticator shows, changing every
// 30 s. No library: HMAC-SHA1 over the 30-second step, as every authenticator app does.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secretB32, step) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

const stepNow = (now = Date.now()) => Math.floor(now / 30000);

// the step the code belongs to (now ±1 step for a phone clock a little off), or -1
function matchStep(secretB32, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return -1;
  const s = stepNow(now);
  for (const d of [0, -1, 1]) {
    const want = codeAt(secretB32, s + d);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s + d;
  }
  return -1;
}

function otpauthUri(secretB32, account = 'Admin', issuer = 'NKs EduOrbit') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { newSecret, codeAt, matchStep, stepNow, otpauthUri, base32Encode, base32Decode };
