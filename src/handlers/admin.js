const { Markup } = require('telegraf');
const absenceTypes = require('../services/absenceTypes');
const absences = require('../services/absences');
const admins = require('../services/admins');
const notifications = require('../services/notifications');
const settings = require('../services/settings');
const users = require('../services/users');
const weeklyReport = require('../services/weeklyReport');
const { Role } = require('../models');
const { label } = require('../telegram/format');
const { parseHHMM, formatHHMM, minutesUk, MINUTES_PER_DAY } = require('../utils/time');
const { TIMEZONE } = require('../config');

const NO_RIGHTS = 'У вас немає прав адміністратора.';
const PRIVATE_ONLY = 'Ця команда доступна лише в особистих повідомленнях з ботом.';

const ADD_NOTIFICATION_USAGE = 'Для додавання сповіщення використовуйте формат:\n/add_notification <HH:MM> <повідомлення>\n\nПриклад:\n/add_notification 09:30 Доброго ранку, команда!\n\nЧас у 24-годинному форматі (09:30, 14:15, 18:00).';
const targetUsage = (command) => `Використовуйте: /${command} <chat_id> [topic_id]\n\nПриклад:\n/${command} -1001234567890\n/${command} -1001234567890 123\n\nЩоб отримати chat ID, перешліть повідомлення з чату в @userinfobot`;
const ADD_ADMIN_USAGE = 'Використання: /add_admin <user_id> або відповідьте на повідомлення командою /add_admin';

// Command text after "/command" (handles "/command@botname" too).
function commandPayload(ctx) {
  return ctx.message.text.replace(/^\/\S+\s*/, '');
}

function commandArgs(ctx) {
  const payload = commandPayload(ctx).trim();
  return payload ? payload.split(/\s+/) : [];
}

function adminCommand(handler, { privateOnly = true } = {}) {
  return async (ctx) => {
    if (!admins.isAdmin(ctx.from.id)) return ctx.reply(NO_RIGHTS);
    if (privateOnly && ctx.chat.type !== 'private') return ctx.reply(PRIVATE_ONLY);
    return handler(ctx);
  };
}

function adminAction(handler) {
  return async (ctx) => {
    if (!admins.isAdmin(ctx.from.id)) return ctx.answerCbQuery(NO_RIGHTS);
    return handler(ctx);
  };
}

// Admin action that just opens something: acknowledge the button, then run.
function menuAction(handler) {
  return adminAction(async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return handler(ctx);
  });
}

async function userLabels(ids) {
  const docs = await users.findByUserIds(ids);
  return ids.map((id) => {
    const doc = docs.get(id);
    if (!doc) return { id, text: String(id) };
    const name = [doc.firstName, doc.lastName].filter(Boolean).join(' ');
    return { id, text: label({ userId: id, username: doc.username, displayName: name }) };
  });
}

// --- Admin panel -----------------------------------------------------------

const adminPanel = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Додати сповіщення', 'add_notification')],
  [Markup.button.callback('🗑️ Видалити сповіщення', 'delete_notification')],
  [Markup.button.callback('📋 Переглянути сповіщення', 'view_notifications')],
  [Markup.button.callback('📍 Встановити ціль для сповіщень', 'set_notification_target')],
  [Markup.button.callback('💬 Встановити ціль для команд', 'set_command_target')],
  [Markup.button.callback('⏱ Час нагадувань', 'reminders')],
  [Markup.button.callback('🕘 Робочий день', 'workday')],
  [Markup.button.callback('📊 Отримувачі звіту', 'report_recipients')],
  [Markup.button.callback('📥 Звіт за поточний тиждень', 'report_now')],
  [Markup.button.callback('👑 Додати адміністратора', 'add_admin')],
  [Markup.button.callback('❌ Видалити адміністратора', 'remove_admin')],
  [Markup.button.callback('👥 Переглянути адміністраторів', 'view_admins')]
]);

// --- Notifications -----------------------------------------------------------

async function addNotification(ctx) {
  const match = /^"?(\d{1,2}:\d{2})"?\s+([\s\S]+)$/.exec(commandPayload(ctx).trim());
  if (!match) return ctx.reply(ADD_NOTIFICATION_USAGE);

  const minutes = parseHHMM(match[1]);
  if (minutes === null || minutes >= MINUTES_PER_DAY) {
    return ctx.reply('Невірний час. Використовуйте формат HH:MM (наприклад 09:30, 14:15, 18:00).');
  }
  let message = match[2].trim();
  if (message.length > 1 && message.startsWith('"') && message.endsWith('"')) message = message.slice(1, -1);

  const chatId = settings.get('defaultNotificationChat');
  if (!chatId) {
    return ctx.reply('❌ Ціль для сповіщень не встановлена. Спочатку використайте /set_notification_target.');
  }
  const topicId = settings.get('defaultNotificationTopic');

  try {
    const notification = await notifications.add(ctx.telegram, { minutes, message, chatId, topicId });
    const topicInfo = topicId ? ` (ID теми: ${topicId})` : '';
    return ctx.reply(`✅ Сповіщення успішно додано!\nЧас: ${notification.originalTime} (${TIMEZONE})\nПовідомлення: ${message}${topicInfo}`);
  } catch (err) {
    console.error('Error saving notification:', err);
    return ctx.reply('Помилка при збереженні сповіщення.');
  }
}

function showNotificationsForDeletion(ctx) {
  const items = notifications.list();
  if (items.length === 0) return ctx.reply('Немає сповіщень для видалення.');

  const buttons = items.map((n) => [
    Markup.button.callback(`🗑️ ${n.originalTime} ${n.message.substring(0, 30)}${n.message.length > 30 ? '…' : ''}`, `delete_notif:${n.id}`)
  ]);
  return ctx.reply('Оберіть сповіщення для видалення:', Markup.inlineKeyboard(buttons));
}

function showNotifications(ctx) {
  const items = notifications.list();
  if (items.length === 0) return ctx.reply('Немає запланованих сповіщень.');
  const text = items
    .map((n, i) => `${i + 1}. Час: ${n.originalTime} (щодня)\n   Повідомлення: ${n.message}`)
    .join('\n\n');
  return ctx.reply(`📋 Заплановані сповіщення:\n\n${text}`);
}

async function deleteNotification(ctx) {
  const id = Number(ctx.match[1]);
  const deleted = await notifications.remove(id);
  if (!deleted) return ctx.answerCbQuery('Сповіщення вже видалено.');
  await ctx.answerCbQuery('Сповіщення видалено');
  return ctx.editMessageText(`🗑️ Видалено сповіщення:\n"${deleted.message}"`).catch(() => {});
}

async function clearNotifications(ctx) {
  const count = await notifications.clear();
  return ctx.reply(`✅ Всі сповіщення очищено (${count} сповіщень видалено).`);
}

// --- Targets -----------------------------------------------------------------

const TARGETS = {
  notification: {
    chatKey: 'defaultNotificationChat',
    topicKey: 'defaultNotificationTopic',
    command: 'set_notification_target',
    saved: (info) => `✅ Ціль для сповіщень встановлено: ${info}\n\nСповіщення та нагадування будуть відправлятися до цього чату/топіку.`,
    current: '📍 Поточна ціль для сповіщень',
    none: '❌ Ціль для сповіщень не встановлена. Використовуйте /set_notification_target для встановлення цілі.',
    reset: '✅ Ціль для сповіщень скинуто. Встановіть нову ціль за допомогою /set_notification_target.'
  },
  command: {
    chatKey: 'defaultCommandChat',
    topicKey: 'defaultCommandTopic',
    command: 'set_command_target',
    saved: (info) => `✅ Ціль для відповідей на команди встановлено: ${info}\n\nВсі відповіді на команди будуть відправлятися до цього чату/топіку.`,
    current: '💬 Поточна ціль для відповідей на команди',
    none: '❌ Не встановлено цілі для відповідей на команди. Використовуйте /set_command_target для встановлення цілі.',
    reset: '✅ Ціль для відповідей на команди очищено. Відповіді будуть відправлятися в той же чат, де використовується команда.'
  }
};

async function setTarget(ctx, target) {
  const [chatArg, topicArg] = commandArgs(ctx);
  if (!chatArg) return ctx.reply(targetUsage(target.command));

  const chatId = Number(chatArg);
  const topicId = topicArg ? Number(topicArg) : null;
  if (!Number.isInteger(chatId)) return ctx.reply('Невірний chat ID. Будь ласка, надайте коректний chat ID.');
  if (topicArg && !Number.isInteger(topicId)) return ctx.reply('Невірний topic ID. Будь ласка, надайте коректний topic ID.');

  let chat;
  try {
    chat = await ctx.telegram.getChat(chatId);
  } catch (error) {
    return ctx.reply(`❌ Помилка при встановленні цілі: ${error.description || error.message}\n\nПереконайтесь:\n1. Бота додано до групи\n2. Chat ID вказано вірно\n3. Topic ID вірний (якщо вказано)`);
  }

  await settings.set({ [target.chatKey]: chatId, [target.topicKey]: topicId });
  const info = `${chat.title || chat.username || chat.id}${topicId ? ` (topic ID: ${topicId})` : ''}`;
  return ctx.reply(target.saved(info));
}

function showTarget(ctx, target) {
  const chatId = settings.get(target.chatKey);
  if (!chatId) return ctx.reply(target.none);
  const topicId = settings.get(target.topicKey);
  const topicInfo = topicId ? `\nTopic ID: ${topicId}` : '\nТема: загальний чат (тему не вказано)';
  return ctx.reply(`${target.current}:\nChat ID: ${chatId}${topicInfo}`);
}

async function resetTarget(ctx, target) {
  await settings.set({ [target.chatKey]: null, [target.topicKey]: null });
  return ctx.reply(target.reset);
}

// --- Reminders & work day ------------------------------------------------------

function remindersText() {
  const lines = absenceTypes.TYPES.map((t) => {
    const { firstReminderMin, repeatReminderMin } = absenceTypes.getTimings(t.key);
    return `${t.emoji} ${t.title} (${t.key}): перше нагадування через ${minutesUk(firstReminderMin)}, далі кожні ${repeatReminderMin} хв`;
  });
  const keys = absenceTypes.TYPES.map((t) => t.key).join(', ');
  return `⏱ Час нагадувань:\n\n${lines.join('\n')}\n\nЗмінити: /set_reminder <тип> <хв> [повтор_хв]\nНаприклад: /set_reminder break 10 10\nТипи: ${keys}`;
}

async function setReminder(ctx) {
  const [keyArg, firstArg, repeatArg] = commandArgs(ctx);
  const type = keyArg ? absenceTypes.getType(keyArg.toLowerCase()) : null;
  if (!type || firstArg === undefined) {
    const keys = absenceTypes.TYPES.map((t) => t.key).join(', ');
    return ctx.reply(`Використання: /set_reminder <тип> <хв> [повтор_хв]\nНаприклад: /set_reminder break 10 10\nТипи: ${keys}`);
  }

  const first = Number(firstArg);
  const repeat = repeatArg === undefined ? first : Number(repeatArg);
  const { MIN_REMINDER, MAX_REMINDER } = absenceTypes;
  if (![first, repeat].every((n) => Number.isInteger(n) && n >= MIN_REMINDER && n <= MAX_REMINDER)) {
    return ctx.reply(`Хвилини мають бути цілим числом від ${MIN_REMINDER} до ${MAX_REMINDER}.`);
  }

  await absenceTypes.setTimings(type.key, first, repeat);
  return ctx.reply(`✅ ${type.emoji} ${type.title}: перше нагадування через ${minutesUk(first)}, далі кожні ${repeat} хв.\nДіє для нових відсутностей; для поточних — з наступного нагадування.`);
}

function workdayText() {
  const { start, end } = absences.workingHours();
  return `🕘 Робочий день: ${formatHHMM(start)}–${formatHHMM(end)} (${TIMEZONE})\n\n` +
    'Нагадування надсилаються до кінця робочого дня. Незакриті відсутності автоматично закриваються в кінці дня. ' +
    'Поза робочим часом команди відсутності не приймаються.\n\n' +
    'Змінити: /set_workday <початок> <кінець>\nНаприклад: /set_workday 09:00 18:00';
}

async function setWorkday(ctx) {
  const [startArg, endArg] = commandArgs(ctx);
  const start = startArg === undefined ? null : parseHHMM(startArg);
  const end = endArg === undefined ? null : parseHHMM(endArg);
  if (start === null || end === null || start >= end) {
    return ctx.reply('Використання: /set_workday <HH:MM> <HH:MM>\nПочаток має бути раніше за кінець, наприклад: /set_workday 09:00 18:00');
  }

  await settings.set({ workDayStart: start, workDayEnd: end });
  await absences.rescheduleCloseTimes();
  return ctx.reply(`✅ Робочий день: ${formatHHMM(start)}–${formatHHMM(end)} (${TIMEZONE}).`);
}

// --- Admins ------------------------------------------------------------------

async function addAdmin(ctx) {
  let targetUserId;
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
  } else {
    const [arg] = commandArgs(ctx);
    if (!arg) return ctx.reply(ADD_ADMIN_USAGE);
    targetUserId = Number(arg);
  }
  if (!Number.isInteger(targetUserId)) return ctx.reply('Невірний user ID.');

  await admins.add(targetUserId, ctx.from.id);
  return ctx.reply(`✅ Користувача ${targetUserId} додано як адміністратора.`);
}

async function showAdminsForRemoval(ctx) {
  const removable = admins.list().filter((id) => !admins.isBootstrap(id));
  if (removable.length === 0) {
    return ctx.reply('Немає адміністраторів, яких можна видалити.\nАдміністраторів з DEFAULT_ADMIN_ID можна змінити лише в налаштуваннях сервера (.env).');
  }
  const labels = await userLabels(removable);
  const buttons = labels.map(({ id, text }) => [Markup.button.callback(`❌ ${text}`, `remove_admin:${id}`)]);
  return ctx.reply('Оберіть адміністратора для видалення:', Markup.inlineKeyboard(buttons));
}

async function removeAdmin(ctx) {
  const adminId = Number(ctx.match[1]);
  if (admins.isBootstrap(adminId)) {
    return ctx.answerCbQuery('Цього адміністратора задано в DEFAULT_ADMIN_ID — видалити його можна лише там.', { show_alert: true });
  }
  if (!admins.isAdmin(adminId)) return ctx.answerCbQuery('Цей користувач уже не адміністратор.');

  await admins.remove(adminId);
  const recipients = settings.get('reportRecipients') || [];
  if (recipients.includes(adminId)) {
    await settings.set({ reportRecipients: recipients.filter((id) => id !== adminId) });
  }
  await ctx.answerCbQuery('Адміністратора видалено!');
  return ctx.editMessageText('❌ Адміністратора видалено!').catch(() => {});
}

async function showAdmins(ctx) {
  const ids = admins.list();
  if (ids.length === 0) return ctx.reply('Не встановлено адміністраторів.');
  const labels = await userLabels(ids);
  const lines = labels.map(({ id, text }) => `• ${text}${text === String(id) ? '' : ` — ${id}`}${admins.isBootstrap(id) ? ' (DEFAULT_ADMIN_ID)' : ''}`);
  return ctx.reply(`👑 Адміністратори:\n${lines.join('\n')}`);
}

// --- Roles -------------------------------------------------------------------

async function addRole(ctx) {
  const roleName = commandPayload(ctx).trim();
  if (!roleName) return ctx.reply('Використання: /add_role <назва_ролі>');
  try {
    if (await Role.findOne({ name: roleName })) return ctx.reply(`Роль "${roleName}" вже існує.`);
    await Role.create({ name: roleName });
    return ctx.reply(`Роль "${roleName}" успішно додана.`);
  } catch (error) {
    console.error('Error adding role:', error);
    return ctx.reply('Помилка при додаванні ролі.');
  }
}

async function assignRole(ctx) {
  const args = commandArgs(ctx);
  if (args.length < 2) return ctx.reply('Використання: /assign_role <@username> <назва_ролі>');
  const username = args[0].replace(/^@/, '');
  const roleName = args.slice(1).join(' ');
  try {
    if (!(await Role.findOne({ name: roleName }))) {
      return ctx.reply(`Роль "${roleName}" не знайдена. Спочатку додайте її через /add_role.`);
    }
    await users.assignRole(username, roleName);
    return ctx.reply(`Користувачу @${username} призначено роль "${roleName}".`);
  } catch (error) {
    console.error('Error assigning role:', error);
    return ctx.reply('Помилка при призначенні ролі.');
  }
}

// --- Weekly report -----------------------------------------------------------

function recipientsText() {
  const selected = settings.get('reportRecipients') || [];
  const fallback = selected.length === 0
    ? '\n\nЗараз нікого не обрано — звіт отримують адміністратори з DEFAULT_ADMIN_ID.'
    : '';
  return '📊 Отримувачі щотижневого звіту (щопонеділка о 00:00).\nНатисніть на адміністратора, щоб увімкнути або вимкнути.' +
    `${fallback}\n\nКожен отримувач має хоча б раз натиснути Start в особистому чаті з ботом.`;
}

async function recipientsKeyboard() {
  const selected = new Set(settings.get('reportRecipients') || []);
  const labels = await userLabels(admins.list());
  return Markup.inlineKeyboard(labels.map(({ id, text }) => [
    Markup.button.callback(`${selected.has(id) ? '✅' : '⬜'} ${text}`, `rcpt:${id}`)
  ]));
}

async function showRecipients(ctx) {
  return ctx.reply(recipientsText(), await recipientsKeyboard());
}

async function toggleRecipient(ctx) {
  const userId = Number(ctx.match[1]);
  if (!admins.isAdmin(userId)) return ctx.answerCbQuery('Цей користувач не адміністратор.');

  const selected = new Set(settings.get('reportRecipients') || []);
  let canMessage = true;
  if (selected.has(userId)) {
    selected.delete(userId);
  } else {
    selected.add(userId);
    // A bot can't start a private chat; this fails if the person never pressed Start.
    canMessage = await ctx.telegram.sendChatAction(userId, 'typing').then(() => true, () => false);
  }
  await settings.set({ reportRecipients: [...selected] });

  if (canMessage) {
    await ctx.answerCbQuery('Збережено');
  } else {
    await ctx.answerCbQuery('⚠️ Цей адміністратор ще не натиснув Start у боті — звіт не буде доставлено, доки він цього не зробить.', { show_alert: true });
  }
  return ctx.editMessageText(recipientsText(), await recipientsKeyboard()).catch(() => {});
}

async function reportNow(ctx) {
  await ctx.reply('⏳ Формую звіт…');
  try {
    const sent = await weeklyReport.sendCurrentWeek(ctx.telegram, ctx.from.id);
    if (!sent) return ctx.reply('За поточний тиждень ще немає завершених відсутностей.');
  } catch (err) {
    console.error('Error building report:', err);
    return ctx.reply('Помилка при формуванні звіту.');
  }
}

// --- Registration --------------------------------------------------------------

function register(bot) {
  bot.command('admin_panel', adminCommand((ctx) => ctx.reply('🔧 Панель адміністратора', adminPanel)));

  bot.command('add_notification', adminCommand(addNotification));
  bot.command('delete_notification', adminCommand(showNotificationsForDeletion));
  bot.command('clear_notifications', adminCommand(clearNotifications));

  bot.command('set_notification_target', adminCommand((ctx) => setTarget(ctx, TARGETS.notification)));
  bot.command('notification_target', adminCommand((ctx) => showTarget(ctx, TARGETS.notification)));
  bot.command('reset_notification_target', adminCommand((ctx) => resetTarget(ctx, TARGETS.notification)));
  bot.command('set_command_target', adminCommand((ctx) => setTarget(ctx, TARGETS.command)));
  bot.command('command_target', adminCommand((ctx) => showTarget(ctx, TARGETS.command)));
  bot.command('clear_command_target', adminCommand((ctx) => resetTarget(ctx, TARGETS.command)));

  bot.command('reminders', adminCommand((ctx) => ctx.reply(remindersText())));
  bot.command('set_reminder', adminCommand(setReminder));
  bot.command('workday', adminCommand((ctx) => ctx.reply(workdayText())));
  bot.command('set_workday', adminCommand(setWorkday));

  bot.command('report_recipients', adminCommand(showRecipients));
  bot.command('report_now', adminCommand(reportNow));

  bot.command('add_admin', adminCommand(addAdmin));
  bot.command('delete_admin', adminCommand(showAdminsForRemoval));

  bot.command('add_role', adminCommand(addRole, { privateOnly: false }));
  bot.command('assign_role', adminCommand(assignRole, { privateOnly: false }));

  // Admin panel buttons
  bot.action('add_notification', menuAction((ctx) => ctx.reply(ADD_NOTIFICATION_USAGE)));
  bot.action('delete_notification', menuAction(showNotificationsForDeletion));
  bot.action('view_notifications', menuAction(showNotifications));
  bot.action('clear_notifications', menuAction(clearNotifications));
  bot.action('set_notification_target', menuAction((ctx) => ctx.reply(targetUsage('set_notification_target'))));
  bot.action('set_command_target', menuAction((ctx) => ctx.reply(targetUsage('set_command_target'))));
  bot.action('reset_notification_target', menuAction((ctx) => resetTarget(ctx, TARGETS.notification)));
  bot.action('reminders', menuAction((ctx) => ctx.reply(remindersText())));
  bot.action('workday', menuAction((ctx) => ctx.reply(workdayText())));
  bot.action('report_recipients', menuAction(showRecipients));
  bot.action('report_now', menuAction(reportNow));
  bot.action('add_admin', menuAction((ctx) => ctx.reply(ADD_ADMIN_USAGE)));
  bot.action('remove_admin', menuAction(showAdminsForRemoval));
  bot.action('view_admins', menuAction(showAdmins));

  bot.action(/^delete_notif:(\d+)$/, adminAction(deleteNotification));
  bot.action(/^delete_notif_\d+$/, (ctx) => ctx.answerCbQuery('Ця кнопка застаріла. Відкрийте список сповіщень знову.'));
  bot.action(/^remove_admin[:_](\d+)$/, adminAction(removeAdmin));
  bot.action(/^rcpt:(\d+)$/, adminAction(toggleRecipient));
}

module.exports = register;
