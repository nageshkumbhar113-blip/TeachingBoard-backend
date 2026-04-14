const express = require("express");

const {
  createQuestion,
  deleteQuestion,
  getQuestions,
  updateQuestion
} = require("../controllers/questionController");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, getQuestions);
router.post("/", requireAdmin, createQuestion);
router.put("/:id", requireAdmin, updateQuestion);
router.delete("/:id", requireAdmin, deleteQuestion);

module.exports = router;
