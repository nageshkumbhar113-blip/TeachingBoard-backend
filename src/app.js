require("dotenv").config();

const path    = require("path");
const express = require("express");
const cors    = require("cors");

const authRoutes     = require("./routes/authRoutes");
const quizRoutes     = require("./routes/quizRoutes");
const attemptRoutes  = require("./routes/attemptRoutes");
const lessonRoutes   = require("./routes/lessonRoutes");
const questionRoutes = require("./routes/questionRoutes");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { createRateLimiter }             = require("./middleware/rateLimiter");

const app = express();

// ── CORS ────────────────────────────────────────────────────
// Set CORS_ORIGIN in env: comma-separated list of allowed origins.
// e.g. CORS_ORIGIN=https://teachingboard-frontend.vercel.app,https://teachingboard-backend.onrender.com
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim()).filter(Boolean)
  : null;

app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => {
        // Allow same-origin requests (origin undefined) and listed origins
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    : true,
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
app.use(express.static(path.join(__dirname, "../..")));

// ── Utility endpoints ────────────────────────────────────────
app.get("/ping",         (_req, res) => res.json({ message: "pong" }));
app.get("/api/health",   (_req, res) => res.json({ status: "ok", ts: Date.now() }));
app.get("/favicon.ico",  (_req, res) => res.status(204).end());

// ── Rate limiting on auth ────────────────────────────────────
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      30,               // 30 login attempts per IP per window
  message:  'Too many login attempts — please try again later',
});

// ── API routes ───────────────────────────────────────────────
app.use("/api/auth",      authLimiter, authRoutes);
app.use("/api/quizzes",   quizRoutes);
app.use("/api/attempts",  attemptRoutes);
app.use("/api/lessons",   lessonRoutes);
app.use("/api/questions", questionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
