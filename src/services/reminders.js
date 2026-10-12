const { Markup } = require('telegraf');
const { ActiveAbsence } = require('../models');
const absenceTypes = require('./absenceTypes');
const { endAbsence } = require('./absences');
const { sendMessage } = require('../telegram/send');
const { mention, escapeHtml } = require('../telegram/format');

const TICK_MS = 30 * 1000;
const MINUTE = 60 * 1000;

function backButton(userId) {
  return Markup.inlineKeyboard([[Markup.button.callback('Я повернувся', `back:${userId}`)]]);
}

// Auto-closes absences whose work day has ended, then posts one notice per chat.
async function closeExpired(telegram, now = new Date()) {
  const expired = await ActiveAbsence.find({ closeAt: { $lte: now } });
  const byChat = new Map();
  for (const absence of expired) {
    const result = await endAbsence(absence.userId, 'auto', absence.closeAt);
    if (!result) continue; // closed by the user in the meantime
    const key = `${absence.replyChatId}:${absence.replyTopicId || ''}`;
    if (!byChat.has(key)) byChat.set(key, { chatId: absence.replyChatId, topicId: absence.replyTopicId, lines: [] });
    const type = absenceTypes.getType(absence.type);
    byChat.get(key).lines.push(`• ${mention(absence)} — ${escapeHtml(type ? type.title : absence.type)}`);
  }
  for (const { chatId, topicId, lines } of byChat.values()) {
    await sendMessage(telegram, chatId, topicId,
      `🌙 Робочий день завершено. Автоматично закрито відсутності:\n${lines.join('\n')}`,
      { parse_mode: 'HTML' });
  }
  return expired.length;
}

// Sends reminders that are due. Each reminder is claimed with a conditional
// update first, so overlapping ticks can't send it twice.
async function sendDueReminders(telegram, now = new Date()) {
  const due = await ActiveAbsence.find({ nextReminderAt: { $lte: now }, closeAt: { $gt: now } });
  for (const absence of due) {
    const { repeatReminderMin } = absenceTypes.getTimings(absence.type);
    let next = new Date(absence.nextReminderAt.getTime() + repeatReminderMin * MINUTE);
    if (next <= now) next = new Date(now.getTime() + repeatReminderMin * MINUTE); // bot was down: don't burst
    const claimed = await ActiveAbsence.findOneAndUpdate(
      { _id: absence._id, nextReminderAt: absence.nextReminderAt },
      { $set: { nextReminderAt: next }, $inc: { remindersSent: 1 } }
    );
    if (!claimed) continue;

    const type = absenceTypes.getType(absence.type);
    await sendMessage(telegram, absence.pingChatId, absence.pingTopicId, type.ping(mention(absence)), {
      parse_mode: 'HTML',
      reply_markup: backButton(absence.userId).reply_markup
    });
  }
}

async function tick(telegram, now = new Date()) {
  await closeExpired(telegram, now);
  await sendDueReminders(telegram, now);
}

function start(telegram) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(telegram);
    } catch (err) {
      console.error('Reminder tick failed:', err);
    } finally {
      running = false;
    }
  };
  run(); // catch up on anything that came due while the bot was down
  const timer = setInterval(run, TICK_MS);
  return () => clearInterval(timer);
}

module.exports = { start, tick, closeExpired, sendDueReminders, backButton };
