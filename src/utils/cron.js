const cron = require('node-cron');
const USER_TIMEZONE = process.env.USER_TIMEZONE || 'Europe/Kiev';

function scheduleNotification(bot, notification) {
  cron.schedule(notification.cronTime, () => {
    bot.telegram.sendMessage(notification.chatId, notification.message, {
      message_thread_id: notification.topicId
    }).catch((error) => {
      console.error('Error sending cron notification:', error.description);
      // Fallback: send without thread ID if topic fails
      bot.telegram.sendMessage(notification.chatId, notification.message).catch((err) => {
        console.error('Fallback cron notification failed:', err.description);
      });
    });
  }, {
    timezone: USER_TIMEZONE
  });
}

module.exports = { scheduleNotification };
