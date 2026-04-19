const express = require("express");

const {
  createLesson,
  deleteLesson,
  getLessons,
  updateLesson
} = require("../controllers/lessonController");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", getLessons);
router.post("/", requireAdmin, createLesson);
router.put("/:id", requireAdmin, updateLesson);
router.delete("/:id", requireAdmin, deleteLesson);

module.exports = router;
