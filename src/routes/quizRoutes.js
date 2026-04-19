const express = require("express");
const {
  createQuiz,
  getQuizById,
  getQuizzes
} = require("../controllers/quizController");
const { attachUserIfPresent, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", attachUserIfPresent, getQuizzes);
router.get("/:id", attachUserIfPresent, getQuizById);
router.post("/", requireAdmin, createQuiz);

module.exports = router;
