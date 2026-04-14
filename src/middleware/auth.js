const { verifyToken } = require("../utils/token");

function getBearerToken(headerValue) {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return "";
  }

  return headerValue.slice(7).trim();
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req.headers.authorization || "");

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authorization token is required"
    });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message
    });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access is required"
      });
    }

    next();
  });
}

module.exports = {
  requireAuth,
  requireAdmin
};
