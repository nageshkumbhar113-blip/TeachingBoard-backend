const mongoose = require("mongoose");

let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection) {
    return cachedConnection;
  }

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is required");
  }

  cachedConnection = mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  });

  try {
    await cachedConnection;
    console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
    return cachedConnection;
  } catch (error) {
    cachedConnection = null;
    throw error;
  }
}

module.exports = {
  connectToDatabase,
  mongoose
};
