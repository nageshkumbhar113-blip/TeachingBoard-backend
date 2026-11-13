const crypto = require("crypto");

const TOKEN_TTL_SECONDS = 60 * 60 * 12;

function getSecret() {
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }

  return secret;
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64").toString("utf8");
}

function sign(value) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(value)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createToken(user) {
  const payload = {
    id: user.id,
    name: user.name,
    role: user.role,
    student_code: user.student_code || "",
    teacher_code: user.teacher_code || "",
    parent_code:  user.parent_code  || "",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

// Guest (no-login) visitor of the free part. Carries everything the server
// needs (no User row exists): see middleware/auth.js _guestUserDoc.
const GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function createGuestToken({ gid, name, batch }) {
  const payload = {
    id: `guest:${gid}`,
    name: name || "",
    role: "student",
    guest: true,
    student_code: `GUEST-${gid}`,
    batches: batch ? [batch] : [],
    exp: Math.floor(Date.now() / 1000) + GUEST_TOKEN_TTL_SECONDS
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

// 👥 a team member of the "NKs Team" app (CRM only): 30 days, checked against the member on every request
const STAFF_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
function signStaffToken({ id, name }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { id, name: name || '', role: 'staff', iat: now, exp: now + STAFF_TOKEN_TTL_SECONDS };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifyToken(token) {
  const [encodedPayload, signature] = String(token || "").split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Invalid token format");
  }

  const expectedSignature = sign(encodedPayload);

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload));

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token has expired");
  }

  return payload;
}

function decodeTokenFromHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return null;
  }

  try {
    return verifyToken(headerValue.slice(7).trim());
  } catch (error) {
    return null;
  }
}

module.exports = { signStaffToken,
  createToken,
  createGuestToken,
  verifyToken,
  decodeTokenFromHeader
};
