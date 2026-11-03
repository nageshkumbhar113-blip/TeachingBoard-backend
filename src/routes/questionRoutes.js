const express = require("express");

const {
  bulkSaveQuestions,
  createQuestion,
  deleteQuestion,
  getQuestions,
  updateQuestion
} = require("../controllers/questionController");
const { uploadFigures } = require("../controllers/figureController");
const { requireAdmin, attachUserIfPresent } = require("../middleware/auth");

const router = express.Router();

router.get("/", attachUserIfPresent, getQuestions);
router.post("/", requireAdmin, createQuestion);
router.post("/bulk", requireAdmin, bulkSaveQuestions);
router.post("/figures/upload", requireAdmin, uploadFigures);
router.put("/:id", requireAdmin, updateQuestion);
router.delete("/:id", requireAdmin, deleteQuestion);

module.exports = router;
