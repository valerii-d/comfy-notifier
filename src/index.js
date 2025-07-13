require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { google } = require('googleapis');

// Timezone configuration
const USER_TIMEZONE = process.env.USER_TIMEZONE || 'Europe/Kiev'; // User timezone (configurable)

// Get server's current timezone dynamically
function getServerTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      console.log(`Server timezone detected: ${tz}`);
      return tz;
    }
    throw new Error('Could not detect timezone');
  } catch (error) {
    console.error('Error detecting server timezone:', error);
    return 'UTC'; // Fallback to UTC
  }
}

const SERVER_TIMEZONE = getServerTimezone();

// Google Sheets configuration
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account-key.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Bot token from environment variables
const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory storage (in production, use a database)
const state = {
  admins: new Set(),
  notifications: [],
  usersOut: new Map(), // userId -> { timestamp, chatId, messageId, username, type: 'out' }
  usersLunch: new Map(), // userId -> { timestamp, chatId, messageId, username, type: 'lunch' }
  dutyUsers: new Set(),
  defaultNotificationChat: null, // Default chat for notifications
  defaultNotificationTopic: null, // Default topic for notifications
  defaultCommandChat: null, // Default chat for command responses
  defaultCommandTopic: null, // Default topic for command responses
  userTimeTracking: new Map(), // username -> { totalOutTime: 0, totalLunchTime: 0 }
  userTimezones: new Map() // userId -> timezone
};

// Initialize with default admins if provided
if (process.env.DEFAULT_ADMIN_ID) {
  const adminIds = process.env.DEFAULT_ADMIN_ID.split(',').map(id => id.trim());
  adminIds.forEach(id => {
    const adminId = parseInt(id);
    if (!isNaN(adminId)) {
      state.admins.add(adminId);
      console.log(`Added default admin: ${adminId}`);
    } else {
      console.warn(`Invalid admin ID: ${id}`);
    }
  });
}

// Middleware to check if user is admin
const isAdmin = (ctx) => {
  return state.admins.has(ctx.from.id);
};

// Middleware to check if message is from a group topic
const isGroupTopic = (ctx) => {
  return ctx.chat.type === 'supergroup' && ctx.message?.is_topic_message;
};

// Start command
bot.start((ctx) => {
  ctx.reply('Ласкаво просимо в бот сповіщень! Використовуйте /help, щоб побачити доступні команди.');
});

// Help command
bot.help((ctx) => {
  const isInGroup = ctx.chat.type === 'supergroup' || ctx.chat.type === 'group';
  const isAdminUser = isAdmin(ctx);
  
  if (isInGroup) {
    const helpText = `
🤖 Команди бота (група):

📋 Користувацькі команди:
/out - Відмітити себе як "відсутній"
/lunch - Відмітити себе як "на обіді"
/on_duty - Відмітити себе як "на місці"

📝 Ці команди працюють лише у групових топіках.
    `;
    ctx.reply(helpText);
  } else if (isAdminUser) {
    const helpText = `
🤖 Команди бота (адміністратор):

📋 Користувацькі команди:
/out - Відмітити себе як "відсутній"
/lunch - Відмітити себе як "на обіді"
/on_duty - Відмітити себе як "на місці"
/set_timezone - Встановити персональну таймзону

👑 Адмін-команди:
/admin_panel - Відкрити панель адміністратора
/add_notification - Додати нове сповіщення
/delete_notification - Видалити сповіщення
/set_notification_target - Встановити ціль для сповіщень (група/топік)
/set_command_target - Встановити ціль для відповідей на команди
/notification_target - Перевірити поточну ціль для сповіщень
/command_target - Перевірити поточну ціль для відповідей на команди
/add_admin - Додати нового адміністратора
/delete_admin - Видалити адміністратора
/clear_notifications - Очистити всі сповіщення
/reset_notification_target - Скинути ціль для сповіщень

📝 Користувацькі команди працюють лише у групових топіках.
    `;
    ctx.reply(helpText);
  } else {
    const helpText = `
🤖 Команди бота:

📋 Користувацькі команди:
/out - Відмітити себе як "відсутній"
/lunch - Відмітити себе як "на обіді"
/on_duty - Відмітити себе як "на місці"
/set_timezone - Встановити персональну таймзону

📝 Ці команди працюють лише у групових топіках.
Зверніться до адміністратора для додаткових можливостей.
    `;
    ctx.reply(helpText);
  }
});

// User commands (only work in group topics)
bot.command('out', (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Remove from duty users
  state.dutyUsers.delete(userId);
  
  // Mark as out - use notification target if set, otherwise use current chat
  const targetChatId = state.defaultNotificationChat || ctx.chat.id;
  const targetTopicId = state.defaultNotificationTopic || null;
  
  console.log('User going out:', {
    userId: userId,
    username: username,
    targetChatId: targetChatId,
    targetTopicId: targetTopicId,
    defaultNotificationChat: state.defaultNotificationChat,
    defaultNotificationTopic: state.defaultNotificationTopic
  });
  
  state.usersOut.set(userId, {
    timestamp: Date.now(),
    chatId: targetChatId,
    topicId: targetTopicId,
    messageId: ctx.message.message_id,
    username: username
  });

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic || null;
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `👋 ${username} вийшов. Пінганемо через 15 хвилин, якщо не повернешся.`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `👋 ${username} вийшов. Пінганемо через 15 хвилин, якщо не повернешся.`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback message also failed:', fallbackError.description);
    });
  });
  
  // Schedule first ping in 15 minutes
  setTimeout(() => {
    pingUserIfStillOut(userId);
  }, 15 * 60 * 1000);
});

bot.command('lunch', (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Remove from duty users
  state.dutyUsers.delete(userId);
  
  // Mark as lunch - use notification target if set, otherwise use current chat
  const targetChatId = state.defaultNotificationChat || ctx.chat.id;
  const targetTopicId = state.defaultNotificationTopic || null;
  
  state.usersLunch.set(userId, {
    timestamp: Date.now(),
    chatId: targetChatId,
    topicId: targetTopicId,
    messageId: ctx.message.message_id,
    username: username
  });

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic || null;
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `🍽️ ${username} вийшов на обід. Пінганемо через 30 хвилин, якщо не повернешся.`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending lunch message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `🍽️ ${username} вийшов на обід. Пінганемо через 30 хвилин, якщо не повернешся.`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback lunch message also failed:', fallbackError.description);
    });
  });
  
  // Schedule first ping in 30 minutes
  setTimeout(() => {
    pingUserIfStillLunch(userId);
  }, 30 * 60 * 1000);
});

bot.command('on_duty', (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Check if user was out and calculate time spent
  const outData = state.usersOut.get(userId);
  if (outData) {
    const timeSpent = Date.now() - outData.timestamp;
    updateUserTimeTracking(username, 'out', timeSpent);
    state.usersOut.delete(userId);
  }
  
  // Check if user was on lunch and calculate time spent
  const lunchData = state.usersLunch.get(userId);
  if (lunchData) {
    const timeSpent = Date.now() - lunchData.timestamp;
    updateUserTimeTracking(username, 'lunch', timeSpent);
    state.usersLunch.delete(userId);
  }
  
  // Add to duty users
  state.dutyUsers.add(userId);

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic || null;
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `✅ ${username} повернувся!`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending on_duty message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `✅ ${username} повернувся!`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback on_duty message also failed:', fallbackError.description);
    });
  });
});

// Admin commands
bot.command('admin_panel', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow admin panel in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Панель адміністратора доступна лише в особистих повідомленнях з ботом');
  }

  const adminPanel = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Додати сповіщення', 'add_notification')],
    [Markup.button.callback('🗑️ Видалити сповіщення', 'delete_notification')],
    [Markup.button.callback('📍 Встановити ціль для сповіщень', 'set_notification_target')],
    [Markup.button.callback('💬 Встановити ціль для команд', 'set_command_target')],
    [Markup.button.callback('👑 Додати адміністратора', 'add_admin')],
    [Markup.button.callback('❌ Видалити адміністратора', 'remove_admin')],
    [Markup.button.callback('📋 Переглянути сповіщення', 'view_notifications')],
    [Markup.button.callback('👥 Переглянути адміністраторів', 'view_admins')]
  ]);

  ctx.reply('🔧 Панель адміністратора', adminPanel);
});

// Callback query handler
bot.action(/.*/, async (ctx) => {
  const action = ctx.match[0];
  
  if (action === 'add_notification') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    ctx.reply('Для додавання сповіщення, використовуйте наступний формат:\n/add_notification <time> <message>\n\nПриклад:\n/add_notification "09:30" "Good morning team!"\n\nTime format: HH:MM (24-часовий формат, e.g., 09:30, 14:15, 18:00)');
  }
  
  else if (action === 'delete_notification') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    showNotificationsForDeletion(ctx);
  }
  
  else if (action === 'add_admin') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    ctx.reply('Для додавання адміністратора, відповідьте на повідомлення з /add_admin або використовуйте:\n/add_admin <user_id>');
  }
  
  else if (action === 'remove_admin') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    showAdminsForRemoval(ctx);
  }
  
  else if (action === 'view_notifications') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    showNotifications(ctx);
  }
  
  else if (action === 'view_admins') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    showAdmins(ctx);
  }
  
  else if (action === 'set_notification_target') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    
    ctx.reply('Для встановлення цілі для сповіщень, використовуйте наступний формат:\n/set_notification_target <chat_id> [topic_id]\n\nПриклад:\n/set_notification_target -1001234567890\n/set_notification_target -1001234567890 123\n\nЩоб отримати chat ID, перешліть повідомлення з чату в @userinfobot');
  }
  
  else if (action === 'set_command_target') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    
    ctx.reply('Для встановлення цілі для відповідей на команди, використовуйте наступний формат:\n/set_command_target <chat_id> [topic_id]\n\nПриклад:\n/set_command_target -1001234567890\n/set_command_target -1001234567890 123\n\nЩоб отримати chat ID, перешліть повідомлення з чату в @userinfobot');
  }
  
  else if (action === 'im_back') {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    // Check if user was out and calculate time spent
    const outData = state.usersOut.get(userId);
    if (outData) {
      const timeSpent = Date.now() - outData.timestamp;
      updateUserTimeTracking(username, 'out', timeSpent);
      state.usersOut.delete(userId);
    }
    
    // Check if user was on lunch and calculate time spent
    const lunchData = state.usersLunch.get(userId);
    if (lunchData) {
      const timeSpent = Date.now() - lunchData.timestamp;
      updateUserTimeTracking(username, 'lunch', timeSpent);
      state.usersLunch.delete(userId);
    }
    
    // Add to duty users
    state.dutyUsers.add(userId);
    
    ctx.answerCbQuery('З поверненням!');
    ctx.editMessageText(`✅ ${username} повернувся!`);
  }
  
  else if (action.startsWith('delete_notif_')) {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    
    const index = parseInt(action.split('_')[2]);
    if (index >= 0 && index < state.notifications.length) {
      const deleted = state.notifications.splice(index, 1)[0];
      ctx.answerCbQuery(`Сповіщення видалено: ${deleted.message}`);
      ctx.editMessageText(`🗑️ Знайдено сповіщення:\n"${deleted.message}"`);
    }
  }
  
  else if (action.startsWith('remove_admin_')) {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    
    const adminId = parseInt(action.split('_')[2]);
    if (state.admins.has(adminId)) {
      state.admins.delete(adminId);
      ctx.answerCbQuery('Адміна видалено!');
      ctx.editMessageText('❌ Адміна видалено!');
    }
  }
  else if (action === 'clear_notifications') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    
    const count = state.notifications.length;
    state.notifications = [];
    ctx.reply(`✅ Всі сповіщення очищено (${count} сповіщень видалено).`);
  }
  
  else if (action === 'reset_notification_target') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    
    state.defaultNotificationChat = null;
    state.defaultNotificationTopic = null;
    ctx.reply('✅ Ціль для сповіщень скинуто. Встановіть нову ціль за допомогою /set_notification_target.');
  }
});

// Admin command handlers
bot.command('add_notification', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('You do not have admin privileges.');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('This command is only available in private chat with the bot.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /add_notification <time> <message>\nExample: /add_notification "09:30" "Good morning team!"');
  }

  const timeInput = args[0].replace(/^\"|\"$/g, ''); // Remove quotes if present
  const message = args.slice(1).join(' ');

  // Parse time format (HH:MM)
  const timeRegex = /^(\d{1,2}):(\d{2})$/;
  const timeMatch = timeInput.match(timeRegex);

  if (!timeMatch) {
    return ctx.reply('Invalid time format. Please use HH:MM format (e.g., 09:30, 14:15, 18:00)');
  }

  const hour = parseInt(timeMatch[1]);
  const minute = parseInt(timeMatch[2]);

  // Validate hour and minute ranges
  if (hour < 0 || hour > 23) {
    return ctx.reply('Invalid hour. Please use 0-23 for hours.');
  }
  if (minute < 0 || minute > 59) {
    return ctx.reply('Invalid minute. Please use 0-59 for minutes.');
  }

  // Check if default notification target is set
  if (!state.defaultNotificationChat) {
    return ctx.reply('❌ Ціль для сповіщень не встановлена. Будь ласка, спочатку використовуйте панель адміністратора для встановлення цілі.');
  }

  // Use the default notification target
  const topicId = state.defaultNotificationTopic;

  // Check if server timezone differs from USER_TIMEZONE
  const serverTimezone = SERVER_TIMEZONE; // Use dynamically detected timezone
  const userTimezone = USER_TIMEZONE;
  
  let convertedTime = timeInput;
  let conversionMessage = '';
  
  // Compare timezone offsets instead of string representations
  const serverOffset = moment.tz(serverTimezone).format('Z'); // Get offset like "+03:00"
  const userOffset = moment.tz(userTimezone).format('Z'); // Get offset like "+03:00"
  
  if (serverOffset !== userOffset) {
    // Input time is in USER_TIMEZONE, convert to server timezone
    const userTime = moment.tz({ hour, minute }, userTimezone);
    const serverTime = userTime.clone().tz(serverTimezone);
    const serverHour = serverTime.hour();
    const serverMinute = serverTime.minute();
    
    convertedTime = `${serverHour.toString().padStart(2, '0')}:${serverMinute.toString().padStart(2, '0')}`;
    conversionMessage = `\n⏰ Конвертовано з ${userTimezone} (${timeInput}) до ${serverTimezone} (${convertedTime})`;
  }

  // Convert to UTC for cron scheduling only if timezones differ
  let utcHour, utcMinute;
  
  if (serverOffset !== userOffset) {
    // Timezones differ - convert to UTC for cron
    const timezoneForCron = serverTimezone;
    const timeForCron = moment.tz({ 
      hour: parseInt(convertedTime.split(':')[0]), 
      minute: parseInt(convertedTime.split(':')[1]) 
    }, timezoneForCron);
    utcHour = timeForCron.clone().tz('UTC').hour();
    utcMinute = timeForCron.clone().tz('UTC').minute();
  } else {
    // Same timezone - use input time directly for cron (no UTC conversion needed)
    utcHour = parseInt(convertedTime.split(':')[0]);
    utcMinute = parseInt(convertedTime.split(':')[1]);
  }

  // Convert to cron expression (minute hour * * *)
  const cronTime = `${utcMinute} ${utcHour} * * *`;

  const notification = {
    id: Date.now(),
    cronTime: cronTime,
    originalTime: convertedTime, // Store converted time for display
    message: message,
    chatId: state.defaultNotificationChat,
    topicId: topicId
  };

  state.notifications.push(notification);

  // Schedule the notification
  scheduleNotification(notification);

  const topicInfo = topicId ? ` (ID теми: ${topicId})` : '';
  ctx.reply(`✅ Сповіщення успішно додано!${conversionMessage}\nЧас: ${convertedTime} (${userTimezone}, буде виконано о ${utcHour.toString().padStart(2, '0')}:${utcMinute.toString().padStart(2, '0')} UTC)${topicInfo}\nПовідомлення: ${message}`);
});

bot.command('delete_notification', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  showNotificationsForDeletion(ctx);
});

bot.command('add_admin', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  let targetUserId;
  
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
  } else {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('Usage: /add_admin <user_id> or reply to a message with /add_admin');
    }
    targetUserId = parseInt(args[1]);
  }

  if (isNaN(targetUserId)) {
    return ctx.reply('Невірний user ID.');
  }

  state.admins.add(targetUserId);
  ctx.reply(`✅ Користувача ${targetUserId} додано як адмінастратора.`);
});

bot.command('delete_admin', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  showAdminsForRemoval(ctx);
});

bot.command('set_notification_target', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Використовуйте: /set_notification_target <chat_id> [topic_id]\n\n Приклад:\n/set_notification_target -1001234567890\n/set_notification_target -1001234567890 123\n\n Щоб отримати chat ID, перешліть повідомлення з цього чату в @userinfobot');
  }

  const chatId = parseInt(args[0]);
  const topicId = args[1] ? parseInt(args[1]) : null;

  if (isNaN(chatId)) {
    return ctx.reply('Невірний chat ID. Будь ласка, надайте коректний chat ID.');
  }

  if (args[1] && isNaN(topicId)) {
    return ctx.reply('Невірний topic ID. Будь ласка, надайте коректний topic ID.');
  }

  // Test if we can access the chat
  bot.telegram.getChat(chatId).then((chat) => {
    state.defaultNotificationChat = chatId;
    state.defaultNotificationTopic = topicId;
    
    const chatInfo = chat.title || chat.username || chat.id;
    const topicInfo = topicId ? ` (topic ID: ${topicId})` : '';
    
    ctx.reply(`✅ Ціль для сповіщень встановлено: ${chatInfo}${topicInfo}\n\nВсі сповіщення будуть відправлятися до цього чату/topic.`);
  }).catch((error) => {
    ctx.reply(`❌ Помилка при встановленні цілі для сповіщень: ${error.description}\n\n Переконайтесь:\n1. Бота додано до групи\n2. Сhat ID вказано вірно\n3. Topic ID вірний (якщо вказано)`);
  });
});

bot.command('notification_target', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  if (!state.defaultNotificationChat) {
    return ctx.reply('❌ Ціль для сповіщень не встановлена. Будь ласка, використовуйте команду /set_notification_target для встановлення цілі.');
  }

  const chatInfo = `Chat ID: ${state.defaultNotificationChat}`;
  const topicInfo = state.defaultNotificationTopic ? `\nTopic ID: ${state.defaultNotificationTopic}` : '\nЧат: Загальний чат (не уточнено чат)';
  
  ctx.reply(`📍 Поточна ціль для сповіщень:\n${chatInfo}${topicInfo}`);
});

bot.command('command_target', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  if (!state.defaultCommandChat) {
    return ctx.reply('❌ Не встановлено цілі для відповідей на команди. Використовуйте /set_command_target для встановлення цілі.');
  }

  const chatInfo = `Chat ID: ${state.defaultCommandChat}`;
  const topicInfo = state.defaultCommandTopic ? `\nTopic ID: ${state.defaultCommandTopic}` : '\nЧат: Загальний чат (не уточнено чат)';
  
  ctx.reply(`💬 Поточна ціль для відповідей на команди:\n${chatInfo}${topicInfo}`);
});

bot.command('set_command_target', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Використовуйте: /set_command_target <chat_id> [topic_id]\n\n Приклад:\n/set_command_target -1001234567890\n/set_command_target -1001234567890 123\n\n Щоб отримати chat ID, перешліть повідомлення з цього чату в @userinfobot');
  }

  const chatId = parseInt(args[0]);
  const topicId = args[1] ? parseInt(args[1]) : null;

  if (isNaN(chatId)) {
    return ctx.reply('Невірний chat ID. Будь ласка, надайте коректний chat ID.');
  }

  if (args[1] && isNaN(topicId)) {
    return ctx.reply('Невірний topic ID. Будь ласка, надайте коректний topic ID.');
  }

  // Test if we can access the chat
  bot.telegram.getChat(chatId).then((chat) => {
    state.defaultCommandChat = chatId;
    state.defaultCommandTopic = topicId;
    
    const chatInfo = chat.title || chat.username || chat.id;
    const topicInfo = topicId ? ` (topic ID: ${topicId})` : '';
    
    ctx.reply(`✅ Ціль для відповідей на команди встановлено: ${chatInfo}${topicInfo}\n\nВсі відповіді на команди будуть відправлятися до цього чату/topic.`);
  }).catch((error) => {
    ctx.reply(`❌ Помилка при встановленні цілі для команд: ${error.description}\n\n Переконайтесь:\n1. Бота додано до групи\n2. Сhat ID вказано вірно\n3. Topic ID вірний (якщо вказано)`);
  });
});

bot.command('clear_command_target', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  state.defaultCommandChat = null;
  state.defaultCommandTopic = null;
  
  ctx.reply('✅ Ціль для відповідей на команди очищено. Відповіді будуть відправлятися в той же чат, де використовується команда.');
});

// Helper functions
function showNotificationsForDeletion(ctx) {
  if (state.notifications.length === 0) {
    return ctx.reply('Немає сповіщень для видалення.');
  }

  const buttons = state.notifications.map((notif, index) => [
    Markup.button.callback(
      `🗑️ ${notif.message.substring(0, 30)}...`,
      `delete_notif_${index}`
    )
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);
  ctx.reply('Оберіть сповіщення для видалення:', keyboard);
}

function showAdminsForRemoval(ctx) {
  if (state.admins.size === 0) {
    return ctx.reply('Немає адміністраторів для видалення.');
  }

  const buttons = Array.from(state.admins).map(adminId => [
    Markup.button.callback(
      `❌ Видалити адміністратора ${adminId}`,
      `remove_admin_${adminId}`
    )
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);
  ctx.reply('Немає адміністраторів для видалення:', keyboard);
}

function showNotifications(ctx) {
  if (state.notifications.length === 0) {
    return ctx.reply('Немає запланованих сповіщень.');
  }

  const notificationsList = state.notifications.map((notif, index) => 
    `${index + 1}. Час: ${notif.originalTime || notif.cronTime} (щодня)\n   Повідомлення: ${notif.message}`
  ).join('\n\n');

  ctx.reply(`📋 Заплановані сповіщення:\n\n${notificationsList}`);
}

function showAdmins(ctx) {
  if (state.admins.size === 0) {
    return ctx.reply('Не встановлено адміністраторів.');
  }

  const adminsList = Array.from(state.admins).join(', ');
  ctx.reply(`👑 Адміністратори: ${adminsList}`);
}

function scheduleNotification(notification) {
  cron.schedule(notification.cronTime, () => {
    const messageOptions = {};
    
    // If there's a topic ID, add it to the message options
    if (notification.topicId) {
      messageOptions.message_thread_id = notification.topicId;
    }
    
    bot.telegram.sendMessage(notification.chatId, notification.message, messageOptions)
      .catch((error) => {
        console.error('Error sending scheduled notification to topic:', error.description);
        // Fallback: send to general chat without topic
        const fallbackOptions = {};
        bot.telegram.sendMessage(notification.chatId, notification.message, fallbackOptions)
          .catch((fallbackError) => {
            console.error('Fallback scheduled notification also failed:', fallbackError.description);
          });
      });
  });
}

function pingUserIfStillOut(userId) {
  const userData = state.usersOut.get(userId);
  if (!userData) return; // User is back on duty

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('I\'m back', 'im_back')]
  ]);

  const messageOptions = {
    reply_markup: keyboard.reply_markup
  };

  // Use the stored topic ID if available
  if (userData.topicId) {
    messageOptions.message_thread_id = userData.topicId;
  }

  bot.telegram.sendMessage(
    userData.chatId,
    `🔔 @${userData.username} Час повертатись!`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending ping message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {
      reply_markup: keyboard.reply_markup
    };
    bot.telegram.sendMessage(
      userData.chatId,
      `🔔 @${userData.username} Час повертатись!`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback ping message also failed:', fallbackError.description);
    });
  });

  // Schedule next ping in 15 minutes
  setTimeout(() => {
    pingUserIfStillOut(userId);
  }, 15 * 60 * 1000);
}

function updateUserTimeTracking(username, type, timeSpent) {
  if (!state.userTimeTracking.has(username)) {
    state.userTimeTracking.set(username, {
      totalOutTime: 0,
      totalLunchTime: 0
    });
  }
  
  const tracking = state.userTimeTracking.get(username);
  
  if (type === 'out') {
    tracking.totalOutTime += timeSpent;
  } else if (type === 'lunch') {
    tracking.totalLunchTime += timeSpent;
  }
}

function pingUserIfStillLunch(userId) {
  const userData = state.usersLunch.get(userId);
  if (!userData) return; // User is back on duty

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Я повернувся', 'im_back')]
  ]);

  const messageOptions = {
    reply_markup: keyboard.reply_markup
  };

  // Use the stored topic ID if available
  if (userData.topicId) {
    messageOptions.message_thread_id = userData.topicId;
  }

  bot.telegram.sendMessage(
    userData.chatId,
    `🍽️ @${userData.username} Час повертатися з обіду!`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending lunch ping message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {
      reply_markup: keyboard.reply_markup
    };
    bot.telegram.sendMessage(
      userData.chatId,
      `🍽️ @${userData.username} Час повертатися з обіду!`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback lunch ping message also failed:', fallbackError.description);
    });
  });

  // Schedule next ping in 30 minutes
  setTimeout(() => {
    pingUserIfStillLunch(userId);
  }, 30 * 60 * 1000);
}

async function saveTimeTrackingToGoogleSheets() {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      console.log('Google Spreadsheet ID not configured, skipping data save');
      return;
    }

    const today = moment().tz(USER_TIMEZONE);
    const monthYear = today.format('YYYY-MM'); // e.g., "2024-01"
    const sheetName = `Sheet_${monthYear}`;
    const rows = [];

    // Prepare data for current users
    for (const [username, tracking] of state.userTimeTracking) {
      const outHours = Math.round((tracking.totalOutTime / (1000 * 60 * 60)) * 100) / 100;
      const lunchHours = Math.round((tracking.totalLunchTime / (1000 * 60 * 60)) * 100) / 100;
      
      rows.push([
        today.format('YYYY-MM-DD'),
        username,
        outHours,
        lunchHours
      ]);
    }

    if (rows.length > 0) {
      try {
        // Try to append to existing sheet
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:D`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: rows
          }
        });
      } catch (error) {
        if (error.code === 400 && error.message.includes('Unable to parse range')) {
          // Sheet doesn't exist, create it first
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: sheetName
                    }
                  }
                }
              ]
            }
          });

          // Add headers to the new sheet
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1:D1`,
            valueInputOption: 'RAW',
            resource: {
              values: [['Дата', 'Користувач', 'Години відсутності', 'Години обіду']]
            }
          });

          // Now append the data
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:D`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: {
              values: rows
            }
          });
        } else {
          throw error;
        }
      }
      
      console.log(`Saved time tracking data for ${rows.length} users to Google Sheets (${sheetName})`);
      
      // Clear the tracking data after saving
      state.userTimeTracking.clear();
    }
  } catch (error) {
    console.error('Error saving to Google Sheets:', error);
  }
}

// Schedule daily data save at 23:00 Ukrainian time
const saveTimeCron = '0 23 * * *'; // 23:00 daily
cron.schedule(saveTimeCron, () => {
  console.log('Running daily time tracking save...');
  saveTimeTrackingToGoogleSheets();
}, {
  timezone: USER_TIMEZONE
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

// Start the bot
bot.launch().then(() => {
  console.log('🤖 Bot is running...');
  
  // Schedule existing notifications
  state.notifications.forEach(scheduleNotification);
}).catch((err) => {
  console.error('Failed to start bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 