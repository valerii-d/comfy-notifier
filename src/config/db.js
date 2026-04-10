const mongoose = require('mongoose');

async function connectDB() {
  const MONGODB_URI = process.env.MONGODB_URI;
  const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'comfy_notifier';

  if (!MONGODB_URI) {
    console.error('Error: MONGODB_URI is not defined in environment variables');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB_NAME });
    console.log(`Connected to MongoDB database: ${MONGODB_DB_NAME}`);
  } catch (err) {
    console.error('Could not connect to MongoDB', err);
    process.exit(1);
  }
}

module.exports = { connectDB };
