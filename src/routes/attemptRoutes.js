const express = require("express");
const { createAttempt, getAttempts } = require("../controllers/attemptController");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, getAttempts);
router.post("/", createAttempt);

module.exports = router;
