const { query, pool } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { createToken } = require("../utils/token");

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function cleanName(name) {
  return String(name || "").trim();
}

exports.login = asyncHandler(async (req, res) => {
  const role = normalizeRole(req.body.role);

  if (!role || !["admin", "student"].includes(role)) {
    return res.status(400).json({
      success: false,
      message: "role must be either admin or student"
    });
  }

  if (role === "admin") {
    const pin = String(req.body.pin || "").trim();

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: "pin is required for admin login"
      });
    }

    const rows = await query(
      "SELECT id, name, role FROM users WHERE role = 'admin' AND pin = ? LIMIT 1",
      [pin]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin PIN"
      });
    }

    const user = rows[0];

    return res.json({
      success: true,
      message: "Admin login successful",
      token: createToken(user),
      user
    });
  }

  const studentName = cleanName(req.body.name);

  if (!studentName) {
    return res.status(400).json({
      success: false,
      message: "name is required for student login"
    });
  }

  let rows = await query(
    "SELECT id, name, role FROM users WHERE role = 'student' AND name = ? LIMIT 1",
    [studentName]
  );

  if (!rows.length) {
    const [result] = await pool.execute(
      "INSERT INTO users (name, role, pin) VALUES (?, 'student', NULL)",
      [studentName]
    );

    rows = [
      {
        id: result.insertId,
        name: studentName,
        role: "student"
      }
    ];
  }

  const user = rows[0];

  res.json({
    success: true,
    message: "Student login successful",
    token: createToken(user),
    user
  });
});
