const express = require("express");
const { createAttempt, getAttempts, getMyAttempts } = require("../controllers/attemptController");
const { requireAdmin, requireStudent } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, getAttempts);
router.get("/my", requireStudent, getMyAttempts);
router.post("/", requireStudent, createAttempt);

module.exports = router;
