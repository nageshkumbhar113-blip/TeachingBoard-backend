const cors = require("cors");
const express = require("express");

const authRoutes = require("./routes/authRoutes");
const questionRoutes = require("./routes/questionRoutes");
const quizRoutes = require("./routes/quizRoutes");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "TeachingBoard backend is healthy"
  });
});

app.use("/api", authRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api", quizRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
