const express = require("express");
const {
  createPattern,
  deletePattern,
  getPatternById,
  getPatterns
} = require("../controllers/quizPatternController");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, getPatterns);
router.get("/:id", requireAdmin, getPatternById);
router.post("/", requireAdmin, createPattern);
router.delete("/:id", requireAdmin, deletePattern);

module.exports = router;
