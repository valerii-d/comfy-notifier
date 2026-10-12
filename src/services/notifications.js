const cron = require('node-cron');
const { Notification } = require('../models');
const { TIMEZONE } = require('../config');
const { sendMessage } = require('../telegram/send');
const { formatHHMM } = require('../utils/time');

// Daily scheduled announcements. Task handles are kept so deleting a
// notification also stops its cron job.
const tasks = new Map(); // notification id -> ScheduledTask
let items = [];

function toPlain(doc) {
  return {
    id: doc.id,
    cronTime: doc.cronTime,
    originalTime: doc.originalTime,
    message: doc.message,
    chatId: doc.chatId,
    topicId: doc.topicId
  };
}

function schedule(telegram, notification) {
  const task = cron.schedule(notification.cronTime, () => {
    sendMessage(telegram, notification.chatId, notification.topicId, notification.message);
  }, { timezone: TIMEZONE });
  tasks.set(notification.id, task);
}

function unschedule(id) {
  const task = tasks.get(id);
  if (task) task.stop();
  tasks.delete(id);
}

async function load(telegram) {
  tasks.forEach((task) => task.stop());
  tasks.clear();
  const docs = await Notification.find({}).sort({ originalTime: 1 });
  items = docs.map(toPlain);
  items.forEach((n) => schedule(telegram, n));
  console.log(`Loaded ${items.length} notifications from MongoDB`);
}

function list() {
  return [...items];
}

async function add(telegram, { minutes, message, chatId, topicId }) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const notification = {
    id: Date.now(),
    cronTime: `${minute} ${hour} * * *`,
    originalTime: formatHHMM(minutes),
    message,
    chatId,
    topicId: topicId || null
  };
  await Notification.create(notification);
  items.push(notification);
  items.sort((a, b) => a.originalTime.localeCompare(b.originalTime));
  schedule(telegram, notification);
  return notification;
}

async function remove(id) {
  const notification = items.find((n) => n.id === id);
  if (!notification) return null;
  unschedule(id);
  await Notification.deleteOne({ id });
  items = items.filter((n) => n.id !== id);
  return notification;
}

async function clear() {
  const count = items.length;
  items.forEach((n) => unschedule(n.id));
  await Notification.deleteMany({});
  items = [];
  return count;
}

module.exports = { load, list, add, remove, clear };
