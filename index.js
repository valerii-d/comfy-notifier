require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const { BOOTSTRAP_ADMIN_IDS, TIMEZONE } = require('./src/config');
const models = require('./src/models');
const settings = require('./src/services/settings');
const admins = require('./src/services/admins');
const absenceTypes = require('./src/services/absenceTypes');
const notifications = require('./src/services/notifications');
const reminders = require('./src/services/reminders');
const weeklyReport = require('./src/services/weeklyReport');
const { createBot, setCommands } = require('./src/bot');

async function main() {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is not defined in environment variables');
  console.log(`Timezone for schedules and reports: ${TIMEZONE}`);

  await connectDB();
  // Brings indexes in line with the schemas (e.g. drops the old unique username index).
  await Promise.all(Object.values(models).map((model) => model.syncIndexes()));

  await settings.load();
  await admins.load(BOOTSTRAP_ADMIN_IDS);
  await absenceTypes.load();
  console.log(`Admins from DEFAULT_ADMIN_ID: ${BOOTSTRAP_ADMIN_IDS.join(', ') || 'none'}`);

  const bot = createBot(process.env.BOT_TOKEN);
  await notifications.load(bot.telegram);
  const stopReminders = reminders.start(bot.telegram);
  const stopReports = weeklyReport.start(bot.telegram);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);
    stopReminders();
    stopReports();
    try {
      bot.stop(signal);
    } catch {
      // not launched yet
    }
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // launch() resolves only when polling stops, so startup logging goes in the callback.
  await bot.launch(() => {
    console.log(`🤖 Bot @${bot.botInfo.username} is running...`);
    setCommands(bot.telegram).catch((err) => console.error('Could not set command list:', err.description || err.message));
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1); // Docker restarts the container
});
