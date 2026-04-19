const express = require("express");

const {
  createQuestion,
  deleteQuestion,
  getQuestions,
  updateQuestion
} = require("../controllers/questionController");
const { requireAdmin, attachUserIfPresent } = require("../middleware/auth");

const router = express.Router();

router.get("/", attachUserIfPresent, getQuestions);
router.post("/", requireAdmin, createQuestion);
router.put("/:id", requireAdmin, updateQuestion);
router.delete("/:id", requireAdmin, deleteQuestion);

module.exports = router;
