const express = require("express");

const { getQuiz, submitQuiz } = require("../controllers/quizController");

const router = express.Router();

router.get("/quiz", getQuiz);
router.post("/submit", submitQuiz);

module.exports = router;
