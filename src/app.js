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

const app = express();

const configuredOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (isLocalOrigin(origin)) {
    return true;
  }

  if (!configuredOrigins.length) {
    return true;
  }

  return configuredOrigins.includes(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(Object.assign(new Error(`CORS blocked for origin: ${origin}`), {
      statusCode: 403
    }));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"]
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// Serve the frontend from the project root
app.use(express.static(path.join(__dirname, "../..")));

app.get("/ping", (_req, res) => res.json({ message: "pong" }));
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "teachingboard-backend",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ── API routes ─────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/quizzes",   quizRoutes);
app.use("/api/attempts",  attemptRoutes);
app.use("/api/lessons",   lessonRoutes);
app.use("/api/questions", questionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
