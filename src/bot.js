const { Telegraf } = require('telegraf');
const registerUserHandlers = require('./handlers/user');
const registerAdminHandlers = require('./handlers/admin');
const absenceTypes = require('./services/absenceTypes');

function createBot(token, options = {}) {
  const bot = new Telegraf(token, options);
  registerUserHandlers(bot);
  registerAdminHandlers(bot);
  // Stop the loading spinner on stale or unknown buttons.
  bot.on('callback_query', (ctx) => ctx.answerCbQuery().catch(() => {}));
  bot.catch((err, ctx) => console.error(`Error for ${ctx.updateType}:`, err));
  return bot;
}

// Command autocomplete in Telegram's "/" menu.
async function setCommands(telegram) {
  const absenceCommands = absenceTypes.TYPES.map((t) => ({ command: t.command, description: `Я ${t.helpStatus}` }));
  await telegram.setMyCommands([
    ...absenceCommands,
    { command: 'on_duty', description: 'Я на місці' },
    { command: 'help', description: 'Список команд' }
  ], { scope: { type: 'all_group_chats' } });
  await telegram.setMyCommands([
    { command: 'help', description: 'Список команд' },
    { command: 'my_role', description: 'Моя роль' },
    { command: 'admin_panel', description: 'Панель адміністратора' }
  ], { scope: { type: 'all_private_chats' } });
}

module.exports = { createBot, setCommands };
