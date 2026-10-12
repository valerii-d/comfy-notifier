const { Admin } = require('../models');

// Bootstrap admins come from DEFAULT_ADMIN_ID and can only be removed there.
// Admins added through the bot are persisted in the `admins` collection.
let bootstrapIds = [];
const dbAdminIds = new Set();

async function load(bootstrap) {
  bootstrapIds = [...bootstrap];
  dbAdminIds.clear();
  const docs = await Admin.find({});
  docs.forEach((doc) => dbAdminIds.add(doc.userId));
}

function isAdmin(userId) {
  return bootstrapIds.includes(userId) || dbAdminIds.has(userId);
}

function isBootstrap(userId) {
  return bootstrapIds.includes(userId);
}

function list() {
  return [...new Set([...bootstrapIds, ...dbAdminIds])];
}

function bootstrap() {
  return [...bootstrapIds];
}

async function add(userId, addedBy) {
  await Admin.updateOne(
    { userId },
    { $setOnInsert: { userId, addedBy, addedAt: new Date() } },
    { upsert: true }
  );
  dbAdminIds.add(userId);
}

async function remove(userId) {
  await Admin.deleteOne({ userId });
  dbAdminIds.delete(userId);
}

module.exports = { load, isAdmin, isBootstrap, list, bootstrap, add, remove };
