// Admin login security (owner 2026-11-22, security audit G).
//   • PIN (6 digits from now on) + Google Authenticator code once the owner turns "enforce" on;
//   • "remember this device 30 days": the code is asked again only on a new / forgotten device;
//   • 10 one-time backup codes for a lost phone;
//   • wrong PINs / codes are limited for ALL networks together (an attacker using many IPs gets
//     nowhere), and every failed / blocked attempt is logged for Admin › Settings › 🔐 सुरक्षा.
// Kill switch (owner locked out, no backup code): ADMIN_2FA_OFF=1 in the Render environment.
const crypto = require('crypto');
const AdminSecurity = require('../models/AdminSecurity');
const T = require('./totp');

const DEVICE_DAYS = 30;
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

function _key() {
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return crypto.createHash('sha256').update('admin-totp:' + secret).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, data] = String(sealed || '').split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function doc() {
  return (await AdminSecurity.findOne({ key: 'main' })) || AdminSecurity.create({ key: 'main' });
}

// ── all networks together: after 10 failures in 15 minutes, one try a minute ──
const FAIL_WINDOW = 15 * 60e3, FAIL_FREE = 10, SLOW_MS = 60e3;
let _fails = [], _lastTry = 0;
function blocked(now = Date.now()) {
  _fails = _fails.filter(t => now - t < FAIL_WINDOW);
  if (_fails.length < FAIL_FREE) return 0;
  const wait = _lastTry + SLOW_MS - now;
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}
function noteTry(now = Date.now()) { _lastTry = now; }

const _ip = req => String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60);
const _ua = req => String(req.headers['user-agent'] || '').slice(0, 120);
async function log(req, kind) {
  await AdminSecurity.updateOne({ key: 'main' },
    { $push: { events: { $each: [{ at: new Date(), kind, ip: _ip(req), ua: _ua(req) }], $slice: -60 } } },
    { upsert: true }).catch(() => {});
}
function fail(req, kind) { _fails.push(Date.now()); log(req, kind); }

function _deviceName(req) {
  const ua = _ua(req);
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'साधन';
  const br = /wv\)|; wv/i.test(ua) ? 'Admin app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} · ${os}`;
}

/**
 * After a correct PIN: is the second step done? → { ok, device_key? } or { ok:false, code, message }.
 * body: { device_key?, otp?, recovery?, remember? }
 */
async function secondStep(req) {
  if (process.env.ADMIN_2FA_OFF === '1') return { ok: true };
  const s = await doc();
  if (!s.totp_on || !s.enforce) return { ok: true };
  const now = new Date();
  const body = req.body || {};
  // a remembered device
  const dk = String(body.device_key || '');
  if (dk) {
    const d = s.devices.find(x => x.hash === sha(dk) && x.expires > now);
    if (d) {
      await AdminSecurity.updateOne({ key: 'main', 'devices.id': d.id }, { $set: { 'devices.$.last_used': now } }).catch(() => {});
      return { ok: true };
    }
  }
  const otp = String(body.otp || '').replace(/\s/g, '');
  const rec = String(body.recovery || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!otp && !rec) {
    log(req, 'pin_ok_code_asked');
    return { ok: false, code: 'OTP_REQUIRED', message: 'Google Authenticator मधला 6 अंकी code टाका' };
  }
  let good = false;
  if (otp) {
    const step = T.matchStep(open(s.totp_enc), otp);
    if (step > 0 && step > (s.last_step || 0)) {
      const r = await AdminSecurity.updateOne({ key: 'main', last_step: { $lt: step } }, { $set: { last_step: step } });
      good = r.modifiedCount === 1;   // the same code twice → refused
    }
  } else if (rec && s.recovery.includes(sha(rec))) {
    const r = await AdminSecurity.updateOne({ key: 'main', recovery: sha(rec) }, { $pull: { recovery: sha(rec) } });
    good = r.modifiedCount === 1;
    if (good) log(req, 'backup_code_used');
  }
  if (!good) {
    fail(req, 'wrong_code');
    return { ok: false, code: 'OTP_INVALID', message: 'Code चुकीचा किंवा जुना — Authenticator मधला आत्ताचा code टाका' };
  }
  if (body.remember) {
    const key = crypto.randomBytes(32).toString('base64url');
    const d = { id: crypto.randomBytes(6).toString('hex'), hash: sha(key), name: _deviceName(req), created_at: now, last_used: now, expires: new Date(now.getTime() + DEVICE_DAYS * 864e5) };
    await AdminSecurity.updateOne({ key: 'main' }, { $push: { devices: { $each: [d], $slice: -20 } } });
    log(req, 'device_added');
    return { ok: true, device_key: key };
  }
  return { ok: true };
}

// a code (or backup code) for changing security settings while logged in
async function checkCode(code) {
  const s = await doc();
  if (!s.totp_on) return true;
  const c = String(code || '').replace(/\s/g, '');
  const step = T.matchStep(open(s.totp_enc), c);
  if (step > 0 && step > (s.last_step || 0)) {
    const r = await AdminSecurity.updateOne({ key: 'main', last_step: { $lt: step } }, { $set: { last_step: step } });
    if (r.modifiedCount === 1) return true;
  }
  const rec = c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (rec && s.recovery.includes(sha(rec))) {
    const r = await AdminSecurity.updateOne({ key: 'main', recovery: sha(rec) }, { $pull: { recovery: sha(rec) } });
    return r.modifiedCount === 1;
  }
  return false;
}

function newRecovery() {
  const plain = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
  return { plain, hashes: plain.map(p => sha(p.replace(/-/g, ''))) };
}

module.exports = { doc, seal, open, blocked, noteTry, fail, log, secondStep, checkCode, newRecovery, sha, DEVICE_DAYS };
