class AppError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = AppError;
