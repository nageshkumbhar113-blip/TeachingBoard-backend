const express = require("express");
const {
  createQuiz,
  deleteQuiz,
  getQuizById,
  getQuizzes
} = require("../controllers/quizController");
const { attachUserIfPresent, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", attachUserIfPresent, getQuizzes);
router.get("/:id", attachUserIfPresent, getQuizById);
router.post("/", requireAdmin, createQuiz);
router.delete("/:id", requireAdmin, deleteQuiz);

module.exports = router;
