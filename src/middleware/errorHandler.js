function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
}

function normalizeError(error) {
  if (error.name === "ValidationError") {
    return {
      statusCode: 400,
      message: "Validation failed",
      details: Object.values(error.errors).map(item => item.message)
    };
  }

  if (error.name === "StrictModeError") {
    return {
      statusCode: 400,
      message: error.message
    };
  }

  if (error.code === 11000) {
    return {
      statusCode: 409,
      message: "Duplicate resource",
      details: error.keyValue
    };
  }

  return {
    statusCode: error.statusCode || 500,
    message: error.message || "Internal server error",
    details: error.details
  };
}

function errorHandler(error, req, res, next) {
  const normalized = normalizeError(error);

  if (process.env.NODE_ENV !== "test") {
    console.error(error);
  }

  res.status(normalized.statusCode).json({
    success: false,
    message: normalized.message,
    ...(normalized.details ? { details: normalized.details } : {})
  });
}

module.exports = {
  notFoundHandler,
  errorHandler
};
