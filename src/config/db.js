const mongoose = require('mongoose');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Credentials are passed as driver options rather than inside the URI, so a
// password with characters like @ : / ? # % needs no URL-encoding. A URI that
// already contains credentials (e.g. Atlas) is used as is.
function connectionOptions(uri, env = process.env) {
  const options = {
    dbName: env.MONGODB_DB_NAME || 'comfy_notifier',
    // Indexes are managed by the explicit syncIndexes() at startup, which also
    // replaces outdated ones (racing with autoIndex makes that flaky).
    autoIndex: false,
    serverSelectionTimeoutMS: 5000
  };
  const uriHasCredentials = /^mongodb(\+srv)?:\/\/[^/]*@/.test(uri);
  if (!uriHasCredentials && env.MONGO_ROOT_USERNAME && env.MONGO_ROOT_PASSWORD) {
    options.auth = { username: env.MONGO_ROOT_USERNAME, password: env.MONGO_ROOT_PASSWORD };
    options.authSource = 'admin';
  }
  return options;
}

// Retries so the bot survives MongoDB starting slower than it (e.g. after a host reboot).
async function connectDB({ retries = 10, delayMs = 3000 } = {}) {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined in environment variables');
  }
  const options = connectionOptions(MONGODB_URI);

  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(MONGODB_URI, options);
      console.log(`Connected to MongoDB database: ${options.dbName}`);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`MongoDB connection failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

module.exports = { connectDB, connectionOptions };
