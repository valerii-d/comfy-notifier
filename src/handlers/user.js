const absenceTypes = require('../services/absenceTypes');
const absences = require('../services/absences');
const admins = require('../services/admins');
const settings = require('../services/settings');
const { touchUser } = require('../services/users');
const { getStatusMessage } = require('../telegram/status');
const { sendMessage } = require('../telegram/send');
const { escapeHtml, mention, personFrom } = require('../telegram/format');
const { formatHHMM, formatTime, minutesUk } = require('../utils/time');
const { TIMEZONE } = require('../config');

const NOT_IN_TOPIC = 'Ця команда працює лише в темі (топіку) групового чату.';

function isGroupTopic(ctx) {
  return (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') && ctx.message?.is_topic_message;
}

// Replies to /out etc. go to the command target if set, else back to the command's topic.
function replyTarget(ctx) {
  const chatId = settings.get('defaultCommandChat');
  if (chatId) return { chatId, topicId: settings.get('defaultCommandTopic') };
  return { chatId: ctx.chat.id, topicId: ctx.message?.message_thread_id || null };
}

// Reminder pings go to the notification target if set, else to the command's topic.
function pingTarget(ctx) {
  const chatId = settings.get('defaultNotificationChat');
  if (chatId) return { chatId, topicId: settings.get('defaultNotificationTopic') };
  return { chatId: ctx.chat.id, topicId: ctx.message?.message_thread_id || null };
}

async function safeTouchUser(from) {
  try {
    return await touchUser(from);
  } catch (err) {
    console.error('Error updating user in DB:', err);
    return null;
  }
}

function roleSuffix(user) {
  return user && user.role ? ` (${escapeHtml(user.role)})` : '';
}

async function handleAbsence(ctx, type) {
  if (!isGroupTopic(ctx)) return ctx.reply(NOT_IN_TOPIC);

  const user = await safeTouchUser(ctx.from);
  const person = personFrom(ctx.from);
  const result = await absences.startAbsence({
    person,
    typeKey: type.key,
    ping: pingTarget(ctx),
    reply: replyTarget(ctx)
  });

  if (result.status === 'outside_hours') {
    const { start, end } = absences.workingHours();
    return ctx.reply(`⏰ Зараз неробочий час. Робочий день: ${formatHHMM(start)}–${formatHHMM(end)}.`);
  }
  if (result.status === 'already') {
    return ctx.reply(`${type.emoji} Ви вже відмічені: «${type.title}» з ${formatTime(result.absence.startedAt, TIMEZONE)}.`);
  }

  const { absence } = result;
  let text = type.started(`${mention(person)}${roleSuffix(user)}`);
  if (absence.nextReminderAt < absence.closeAt) {
    const firstMin = Math.round((absence.nextReminderAt - absence.startedAt) / 60000);
    text += ` Пінганемо через ${minutesUk(firstMin)}, якщо не повернешся.`;
  }
  text += await getStatusMessage();

  const { chatId, topicId } = replyTarget(ctx);
  await sendMessage(ctx.telegram, chatId, topicId, text, { parse_mode: 'HTML' });
}

async function handleReturn(ctx) {
  if (!isGroupTopic(ctx)) return ctx.reply(NOT_IN_TOPIC);

  const user = await safeTouchUser(ctx.from);
  await absences.endAbsence(ctx.from.id, 'command');
  const text = `✅ ${mention(personFrom(ctx.from))}${roleSuffix(user)} повернувся!${await getStatusMessage()}`;

  const { chatId, topicId } = replyTarget(ctx);
  await sendMessage(ctx.telegram, chatId, topicId, text, { parse_mode: 'HTML' });
}

// "Я повернувся" under a reminder. Only the reminded person (or an admin) may press it.
async function handleBackButton(ctx, targetUserId) {
  if (ctx.from.id !== targetUserId && !admins.isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Ця кнопка для іншого користувача.', { show_alert: true });
  }
  const result = await absences.endAbsence(targetUserId, 'button');
  if (!result) {
    await ctx.answerCbQuery('Відсутність уже закрита.');
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  }
  await ctx.answerCbQuery('З поверненням!');
  await ctx.editMessageText(`✅ ${mention(result.absence)} повернувся!`, { parse_mode: 'HTML' })
    .catch((err) => console.error('Error editing reminder message:', err.description || err.message));
}

function userCommandsHelp() {
  const lines = absenceTypes.TYPES.map((t) => `/${t.command} - Відмітити себе як "${t.helpStatus}"`);
  return [...lines, '/on_duty - Відмітити себе як "на місці"'].join('\n');
}

const ADMIN_HELP = `
👑 Адмін-команди (в особистих повідомленнях з ботом):
/admin_panel - Панель адміністратора
/add_notification <HH:MM> <текст> - Додати щоденне сповіщення
/delete_notification - Видалити сповіщення
/clear_notifications - Видалити всі сповіщення
/set_notification_target <chat_id> [topic_id] - Ціль для сповіщень і нагадувань
/notification_target - Поточна ціль для сповіщень
/reset_notification_target - Скинути ціль для сповіщень
/set_command_target <chat_id> [topic_id] - Ціль для відповідей на команди
/command_target - Поточна ціль для відповідей на команди
/clear_command_target - Скинути ціль для відповідей на команди
/reminders - Час нагадувань
/set_reminder <тип> <хв> [повтор_хв] - Змінити час нагадувань
/workday - Робочий день
/set_workday <HH:MM> <HH:MM> - Початок і кінець робочого дня
/report_recipients - Отримувачі щотижневого звіту
/report_now - Звіт за поточний тиждень
/add_admin <user_id> - Додати адміністратора
/delete_admin - Видалити адміністратора
/add_role <назва_ролі> - Додати нову роль
/assign_role <@username> <назва_ролі> - Призначити роль користувачу`;

function helpText(ctx) {
  const isGroup = ctx.chat.type === 'supergroup' || ctx.chat.type === 'group';
  if (isGroup) {
    return `🤖 Команди бота (група):\n\n📋 Користувацькі команди:\n${userCommandsHelp()}\n\n📝 Ці команди працюють лише у групових топіках.`;
  }
  if (admins.isAdmin(ctx.from.id)) {
    return `🤖 Команди бота (адміністратор):\n\n📋 Користувацькі команди (у групових топіках):\n${userCommandsHelp()}\n/my_role - Перевірити свою роль\n${ADMIN_HELP}`;
  }
  return `🤖 Команди бота:\n\n📋 Користувацькі команди (у групових топіках):\n${userCommandsHelp()}\n/my_role - Перевірити свою роль\n\nЗверніться до адміністратора для додаткових можливостей.`;
}

function register(bot) {
  bot.start((ctx) => ctx.reply('Ласкаво просимо в бот сповіщень! Використовуйте /help, щоб побачити доступні команди.'));
  bot.help((ctx) => ctx.reply(helpText(ctx)));

  for (const type of absenceTypes.TYPES) {
    bot.command(type.command, (ctx) => handleAbsence(ctx, type));
  }
  bot.command('on_duty', handleReturn);

  bot.command('my_role', async (ctx) => {
    const user = await safeTouchUser(ctx.from);
    if (!user) return ctx.reply('Сталася помилка при отриманні вашої ролі.');
    return ctx.reply(user.role ? `Ваша роль: ${user.role}` : 'У вас поки що немає призначеної ролі.');
  });

  bot.action(/^back:(\d+)$/, (ctx) => handleBackButton(ctx, Number(ctx.match[1])));
  bot.action('im_back', (ctx) => handleBackButton(ctx, ctx.from.id)); // buttons sent before this version
}

module.exports = register;
