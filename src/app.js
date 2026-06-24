require("dotenv").config();

if (!process.env.JWT_SECRET && !process.env.AUTH_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server will not start.');
  process.exit(1);
}

const path    = require("path");
const express = require("express");
const cors    = require("cors");

const authRoutes     = require("./routes/authRoutes");
const quizRoutes     = require("./routes/quizRoutes");
const attemptRoutes  = require("./routes/attemptRoutes");
const lessonRoutes   = require("./routes/lessonRoutes");
const questionRoutes = require("./routes/questionRoutes");
const studentRoutes  = require("./routes/studentRoutes");
const batchRoutes    = require("./routes/batchRoutes");
const { adminRouter: teacherAdminRoutes, teacherRouter: teacherDashRoutes } = require("./routes/teacherRoutes");
const { adminRouter: parentAdminRoutes,  parentRouter: parentDashRoutes  } = require("./routes/parentRoutes");
const appVersionRoutes = require("./routes/appVersionRoutes");
const { adminWordRouter, vocabRouter, studentWordRouter } = require("./routes/wordRoutes");
const { adminRouter: wordTestAdminRouter, studentRouter: wordTestStudentRouter } = require("./routes/wordTestRoutes");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { createRateLimiter }             = require("./middleware/rateLimiter");

const app = express();

// ── Security headers ─────────────────────────────────────────
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── CORS ────────────────────────────────────────────────────
// Set CORS_ORIGIN in env: comma-separated list of allowed origins.
// e.g. CORS_ORIGIN=https://teachingboard-frontend.vercel.app,https://teachingboard-backend.onrender.com
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim()).filter(Boolean)
  : null;

// Capacitor Android sends capacitor://localhost (production) or https://localhost (dev)
const CAPACITOR_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl / Render health checks
    if (CAPACITOR_ORIGINS.has(origin)) return cb(null, true);
    if (allowedOrigins && allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// ── No-cache for service worker and env config ───────────────
app.use((req, res, next) => {
  if (/\/(sw\.js|env\.js)(\?.*)?$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// ── Static frontend ─────────────────────────────────────────
// Try repo root first (works locally and on most hosts).
// FRONTEND_ROOT env var allows override when rootDir limits parent access (e.g. Render).
const FRONTEND_ROOT = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : path.resolve(__dirname, "../..");

app.use(express.static(FRONTEND_ROOT));

// ── Utility endpoints ────────────────────────────────────────
app.get("/ping",         (_req, res) => res.json({ message: "pong" }));
app.get("/api/health",   (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ── Short-URL redirects (works on Render without vercel.json) ──
app.get("/student", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, "/student-app/index.html" + qs);
});
app.get("/admin", (req, res) => res.redirect(302, "/admin-app/admin.html"));
app.get("/get-app", (req, res) => res.redirect(302, "/get-app.html"));

// ── Explicit HTML fallbacks (in case static path misses on Render) ──
function _sendFrontend(rel) {
  return (_req, res) => res.sendFile(path.join(FRONTEND_ROOT, rel));
}
app.get("/admin-app/admin.html",    _sendFrontend("admin-app/admin.html"));
app.get("/student-app/",            _sendFrontend("student-app/index.html"));
app.get("/student-app/index.html",  _sendFrontend("student-app/index.html"));
app.get("/favicon.ico",  (_req, res) => res.status(204).end());

// ── Rate limiting on auth ────────────────────────────────────
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      30,               // 30 login attempts per IP per window
  message:  'Too many login attempts — please try again later',
});

const vocabLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  max:      60,         // 60 requests per IP per minute
  message:  'Too many requests — please slow down',
});

// ── API routes ───────────────────────────────────────────────
app.use("/api/auth",      authLimiter, authRoutes);
app.use("/api/quizzes",   quizRoutes);
app.use("/api/attempts",  attemptRoutes);
app.use("/api/lessons",   lessonRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/students",  studentRoutes);
app.use("/api/batches",   batchRoutes);
app.use("/api/teachers",  teacherAdminRoutes);
app.use("/api/teacher",   teacherDashRoutes);
app.use("/api/parents",      parentAdminRoutes);
app.use("/api/parent",       parentDashRoutes);
app.use("/api/app-version",  appVersionRoutes);
app.use("/api/admin/words",      adminWordRouter);
app.use("/api/admin/word-tests", wordTestAdminRouter);
app.use("/api/vocab",            vocabLimiter, vocabRouter);
app.use("/api/student",          vocabLimiter, studentWordRouter);
app.use("/api/word-tests",       vocabLimiter, wordTestStudentRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
