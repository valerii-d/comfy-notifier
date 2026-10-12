const { Config } = require('../models');

// Key/value settings stored in the `configs` collection, cached in memory
// (single bot process, so the cache is authoritative after load()).
const DEFAULTS = {
  defaultNotificationChat: null,
  defaultNotificationTopic: null,
  defaultCommandChat: null,
  defaultCommandTopic: null,
  workDayStart: 0, // minutes after midnight
  workDayEnd: 24 * 60,
  reportRecipients: [] // Telegram user IDs
};

const NUMERIC_KEYS = ['defaultNotificationChat', 'defaultNotificationTopic', 'defaultCommandChat', 'defaultCommandTopic'];

let cache = { ...DEFAULTS };

async function load() {
  cache = { ...DEFAULTS };
  const docs = await Config.find({ key: { $in: Object.keys(DEFAULTS) } });
  for (const doc of docs) {
    if (doc.value === null || doc.value === undefined) continue;
    cache[doc.key] = NUMERIC_KEYS.includes(doc.key) ? Number(doc.value) : doc.value;
  }
}

function get(key) {
  return cache[key];
}

// Writes to MongoDB first, so the cache never holds a value that wasn't saved.
async function set(values) {
  for (const [key, value] of Object.entries(values)) {
    await Config.updateOne({ key }, { $set: { value } }, { upsert: true });
    cache[key] = value;
  }
}

module.exports = { load, get, set, DEFAULTS };
