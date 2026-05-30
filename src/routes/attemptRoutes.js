const express = require("express");
const { createAttempt, getAttempts } = require("../controllers/attemptController");
const { requireAdmin, requireStudent } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, getAttempts);
router.post("/", requireStudent, createAttempt);

module.exports = router;
