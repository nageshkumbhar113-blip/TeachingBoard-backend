const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const app = require("./src/app");
const db = require("./src/config/db");

const connectToDatabase =
  db.connectToDatabase ||
  db.testConnection ||
  db.connect ||
  null;

const mongoose = db.mongoose || null;

function loadEnvironment() {
  const envPath = path.join(__dirname, ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded environment from ${envPath}`);
    return;
  }

  console.log("No local .env file found. Using process environment variables.");
}

function validateRequiredEnv() {
  const requiredKeys = ["MONGODB_URI", "JWT_SECRET"];
  const missingKeys = requiredKeys.filter(key => !String(process.env[key] || "").trim());

  console.log("Startup environment check:", {
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: process.env.PORT || "4000",
    hasMONGODB_URI: !!String(process.env.MONGODB_URI || "").trim(),
    hasJWT_SECRET: !!String(process.env.JWT_SECRET || "").trim(),
    hasCORS_ORIGIN: !!String(process.env.CORS_ORIGIN || "").trim(),
    onRender: !!String(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || "").trim()
  });

  if (missingKeys.length) {
    throw new Error(`Missing required environment variables: ${missingKeys.join(", ")}`);
  }
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  const serialized = {
    message: error.message || "Unknown startup error",
    name: error.name || "Error",
    code: error.code || null,
    errno: error.errno || null,
    syscall: error.syscall || null,
    hostname: error.hostname || null,
    address: error.address || null,
    port: error.port || null,
    stack: error.stack || null
  };

  if (error.cause) {
    serialized.cause = serializeError(error.cause);
  }

  if (Array.isArray(error.errors) && error.errors.length) {
    serialized.errors = error.errors.map(serializeError);
  }

  if (error.reason) {
    serialized.reason = serializeError(error.reason);
  }

  return serialized;
}

async function start() {
  loadEnvironment();
  validateRequiredEnv();
  if (typeof connectToDatabase !== "function") {
    throw new Error("Database connector is missing. Expected connectToDatabase() or testConnection() export from src/config/db.js");
  }
  await connectToDatabase();
  const port = Number(process.env.PORT || 4000);

  const server = app.listen(port, "0.0.0.0", () => {
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://0.0.0.0:${port}`;
    console.log(`TeachingBoard Quiz API running on ${publicUrl}`);
  });

  const shutdown = async signal => {
    console.log(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      if (mongoose?.connection?.close) {
        await mongoose.connection.close();
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error("Startup failed:", serializeError(error));
    process.exit(1);
  });
}

module.exports = { start };
