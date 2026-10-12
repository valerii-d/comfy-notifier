const mongoose = require('mongoose');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries so the bot survives MongoDB starting slower than it (e.g. after a host reboot).
async function connectDB({ retries = 10, delayMs = 3000 } = {}) {
  const MONGODB_URI = process.env.MONGODB_URI;
  const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'comfy_notifier';

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined in environment variables');
  }

  for (let attempt = 1; ; attempt++) {
    try {
      // autoIndex off: indexes are managed by the explicit syncIndexes() at startup,
      // which also replaces outdated ones (racing with autoIndex makes that flaky).
      await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB_NAME, autoIndex: false, serverSelectionTimeoutMS: 5000 });
      console.log(`Connected to MongoDB database: ${MONGODB_DB_NAME}`);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`MongoDB connection failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

module.exports = { connectDB };
