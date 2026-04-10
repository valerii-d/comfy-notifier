require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { connectDB } = require('./src/config/db');
const { Notification, Config, User, Role } = require('./src/models');
const { getServerTimezone } = require('./src/utils/timezone');
const { getStatusMessage } = require('./src/utils/helpers');
const { scheduleNotification } = require('./src/utils/cron');
const { saveTimeTrackingToGoogleSheets } = require('./src/utils/sheets');
const { isAdmin: isAdminBase, isGroupTopic } = require('./src/middleware/auth');

// Middleware wrapper for state
const isAdmin = (ctx) => isAdminBase(state, ctx);

// Timezone configuration
const USER_TIMEZONE = process.env.USER_TIMEZONE || 'Europe/Kiev'; 
const SERVER_TIMEZONE = getServerTimezone();

// Bot instance
const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory storage
const state = {
  admins: new Set(),
  notifications: [],
  usersOut: new Map(), // userId -> { timestamp, chatId, messageId, username, type: 'out' }
  usersLunch: new Map(), // userId -> { timestamp, chatId, messageId, username, type: 'lunch' }
  dutyUsers: new Set(),
  defaultNotificationChat: null,
  defaultNotificationTopic: null,
  defaultCommandChat: null,
  defaultCommandTopic: null,
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
/my_role - Перевірити свою роль

👑 Адмін-команди:
/admin_panel - Відкрити панель адміністратора
/add_role <назва_ролі> - Додати нову роль
/assign_role <@username> <назва_ролі> - Призначити роль користувачу
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
/my_role - Перевірити свою роль

📝 Ці команди працюють лише у групових топіках.
Зверніться до адміністратора для додаткових можливостей.
    `;
    ctx.reply(helpText);
  }
});

// Helper to get users status message
async function getStatusMessageProxy() {
  return getStatusMessage(state);
}

// User commands (only work in group topics)
bot.command('out', async (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Update or create user in DB
  const user = await User.findOneAndUpdate(
    { username: ctx.from.username || username },
    { userId: userId, username: ctx.from.username || username },
    { upsert: true, new: true }
  ).catch(err => {
    console.error('Error updating user in DB:', err);
    return null;
  });

  const roleStr = user && user.role ? ` (${user.role})` : '';

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

  const statusMsg = await getStatusMessageProxy();

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic !== null ? state.defaultCommandTopic : (ctx.message?.message_thread_id || null);
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `👋 @${username}${roleStr} вийшов. Пінганемо через 15 хвилин, якщо не повернешся.${statusMsg}`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `👋 ${username}${roleStr} вийшов. Пінганемо через 15 хвилин, якщо не повернешся.${statusMsg}`,
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

bot.command('lunch', async (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Update or create user in DB
  const user = await User.findOneAndUpdate(
    { username: ctx.from.username || username },
    { userId: userId, username: ctx.from.username || username },
    { upsert: true, new: true }
  ).catch(err => {
    console.error('Error updating user in DB:', err);
    return null;
  });

  const roleStr = user && user.role ? ` (${user.role})` : '';

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

  const statusMsg = await getStatusMessageProxy();

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic !== null ? state.defaultCommandTopic : (ctx.message?.message_thread_id || null);
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `🍽️ @${username}${roleStr} вийшов на обід. Пінганемо через 30 хвилин, якщо не повернешся.${statusMsg}`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending lunch message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `🍽️ ${username}${roleStr} вийшов на обід. Пінганемо через 30 хвилин, якщо не повернешся.${statusMsg}`,
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

bot.command('on_duty', async (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Update or create user in DB
  const user = await User.findOneAndUpdate(
    { username: ctx.from.username || username },
    { userId: userId, username: ctx.from.username || username },
    { upsert: true, new: true }
  ).catch(err => {
    console.error('Error updating user in DB:', err);
    return null;
  });

  const roleStr = user && user.role ? ` (${user.role})` : '';

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

  const statusMsg = await getStatusMessageProxy();

  // Send response to command target if set, otherwise to current chat
  const responseChatId = state.defaultCommandChat || ctx.chat.id;
  const responseTopicId = state.defaultCommandTopic !== null ? state.defaultCommandTopic : (ctx.message?.message_thread_id || null);
  
  const messageOptions = {};
  if (responseTopicId) {
    messageOptions.message_thread_id = responseTopicId;
  }

  bot.telegram.sendMessage(
    responseChatId,
    `✅ @${username}${roleStr} повернувся!${statusMsg}`,
    messageOptions
  ).catch((error) => {
    console.error('Error sending on_duty message to topic:', error.description);
    // Fallback: send to general chat without topic
    const fallbackOptions = {};
    bot.telegram.sendMessage(
      responseChatId,
      `✅ ${username}${roleStr} повернувся!${statusMsg}`,
      fallbackOptions
    ).catch((fallbackError) => {
      console.error('Fallback on_duty message also failed:', fallbackError.description);
    });
  });
});

bot.command('my_role', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  try {
    const user = await User.findOne({ 
      $or: [
        { userId: userId },
        { username: username }
      ]
    });

    if (user && user.role) {
      ctx.reply(`Ваша роль: ${user.role}`);
    } else {
      ctx.reply('У вас поки що немає призначеної ролі.');
    }
  } catch (error) {
    console.error('Error fetching role:', error);
    ctx.reply('Сталася помилка при отриманні вашої ролі.');
  }
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
    ctx.editMessageText(`✅ @${username} повернувся!`);
  }
  
  else if (action.startsWith('delete_notif_')) {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    
    const index = parseInt(action.split('_')[2]);
    if (index >= 0 && index < state.notifications.length) {
      const deleted = state.notifications.splice(index, 1)[0];
      
      // Remove from MongoDB
      Notification.deleteOne({ id: deleted.id }).catch(err => {
        console.error('Error deleting notification from MongoDB:', err);
      });

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

    // Clear from MongoDB
    Notification.deleteMany({}).catch(err => {
      console.error('Error clearing notifications from MongoDB:', err);
    });

    ctx.reply(`✅ Всі сповіщення очищено (${count} сповіщень видалено).`);
  }
  
  else if (action === 'reset_notification_target') {
    if (!isAdmin(ctx)) {
      return ctx.answerCbQuery('У вас не має прав адміністратора');
    }
    ctx.answerCbQuery();
    
    state.defaultNotificationChat = null;
    state.defaultNotificationTopic = null;

    // Update MongoDB config
    Config.updateOne({ key: 'defaultNotificationChat' }, { value: null }, { upsert: true }).catch(err => {
      console.error('Error updating notification chat in MongoDB:', err);
    });
    Config.updateOne({ key: 'defaultNotificationTopic' }, { value: null }, { upsert: true }).catch(err => {
      console.error('Error updating notification topic in MongoDB:', err);
    });

    ctx.reply('✅ Ціль для сповіщень скинуто. Встановіть нову ціль за допомогою /set_notification_target.');
  }
});

// Admin command handlers
bot.command('add_notification', async (ctx) => {
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

  // Timezone information
  const userTimezone = USER_TIMEZONE;
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

  // Convert to cron expression (minute hour * * *) in local time
  const cronTime = `${minute} ${hour} * * *`;

  const notification = {
    id: Date.now(),
    cronTime: cronTime,
    originalTime: timeStr,
    message: message,
    chatId: state.defaultNotificationChat,
    topicId: topicId
  };

  state.notifications.push(notification);

  // Save to MongoDB
  try {
    const dbNotification = new Notification(notification);
    await dbNotification.save();
  } catch (error) {
    console.error('Error saving notification to MongoDB:', error);
  }

  // Schedule the notification
  scheduleNotificationProxy(notification);

  const topicInfo = topicId ? ` (ID теми: ${topicId})` : '';
  ctx.reply(`✅ Сповіщення успішно додано!\nЧас: ${timeStr} (${userTimezone})\nПовідомлення: ${message}${topicInfo}`);
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

bot.command('add_role', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const roleName = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!roleName) {
    return ctx.reply('Використання: /add_role <назва_ролі>');
  }

  try {
    const existingRole = await Role.findOne({ name: roleName });
    if (existingRole) {
      return ctx.reply(`Роль "${roleName}" вже існує.`);
    }

    const newRole = new Role({ name: roleName });
    await newRole.save();
    ctx.reply(`Роль "${roleName}" успішно додана.`);
  } catch (error) {
    console.error('Error adding role:', error);
    ctx.reply('Помилка при додаванні ролі.');
  }
});

bot.command('assign_role', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Використання: /assign_role <@username> <назва_ролі>');
  }

  const username = args[0].replace('@', '');
  const roleName = args.slice(1).join(' ').trim();

  try {
    const role = await Role.findOne({ name: roleName });
    if (!role) {
      return ctx.reply(`Роль "${roleName}" не знайдена. Спочатку додайте її через /add_role.`);
    }

    let user = await User.findOne({ username: username });
    if (user) {
      user.role = roleName;
      await user.save();
    } else {
      // We don't have the userId yet if the user hasn't interacted with the bot
      // But we can create a record with just the username and role
      // and update it later when they use a command.
      // However, MongoDB unique index on userId might fail if we leave it null.
      // Let's adjust the schema or handle it differently.
      // For now, let's assume we want to update existing users or wait for them.
      // Better: Create/Update by username, and we'll fill userId when they use /out etc.
      user = await User.findOneAndUpdate(
        { username: username },
        { role: roleName },
        { upsert: true, new: true }
      );
    }

    ctx.reply(`Користувачу @${username} призначено роль "${roleName}".`);
  } catch (error) {
    console.error('Error assigning role:', error);
    ctx.reply('Помилка при призначенні ролі.');
  }
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
  bot.telegram.getChat(chatId).then(async (chat) => {
    state.defaultNotificationChat = chatId;
    state.defaultNotificationTopic = topicId;
    
    // Save to MongoDB config
    try {
      await Config.updateOne({ key: 'defaultNotificationChat' }, { value: chatId }, { upsert: true });
      await Config.updateOne({ key: 'defaultNotificationTopic' }, { value: topicId }, { upsert: true });
    } catch (error) {
      console.error('Error saving notification target to MongoDB:', error);
    }

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
  bot.telegram.getChat(chatId).then(async (chat) => {
    state.defaultCommandChat = chatId;
    state.defaultCommandTopic = topicId;
    
    // Save to MongoDB config
    try {
      await Config.updateOne({ key: 'defaultCommandChat' }, { value: chatId }, { upsert: true });
      await Config.updateOne({ key: 'defaultCommandTopic' }, { value: topicId }, { upsert: true });
    } catch (error) {
      console.error('Error saving command target to MongoDB:', error);
    }

    const chatInfo = chat.title || chat.username || chat.id;
    const topicInfo = topicId ? ` (topic ID: ${topicId})` : '';
    
    ctx.reply(`✅ Ціль для відповідей на команди встановлено: ${chatInfo}${topicInfo}\n\nВсі відповіді на команди будуть відправлятися до цього чату/topic.`);
  }).catch((error) => {
    ctx.reply(`❌ Помилка при встановленні цілі для команд: ${error.description}\n\n Переконайтесь:\n1. Бота додано до групи\n2. Сhat ID вказано вірно\n3. Topic ID вірний (якщо вказано)`);
  });
});

bot.command('clear_command_target', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  state.defaultCommandChat = null;
  state.defaultCommandTopic = null;
  
  // Update MongoDB config
  try {
    await Config.updateOne({ key: 'defaultCommandChat' }, { value: null }, { upsert: true });
    await Config.updateOne({ key: 'defaultCommandTopic' }, { value: null }, { upsert: true });
  } catch (error) {
    console.error('Error clearing command target from MongoDB:', error);
  }

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

// Helper to schedule notification
function scheduleNotificationProxy(notification) {
  return scheduleNotification(bot, notification);
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

// Schedule daily data save at 22:30 Ukrainian time
const saveTimeCron = '30 22 * * *'; // 22:30 daily
cron.schedule(saveTimeCron, () => {
  console.log('Running daily time tracking save...');
  saveTimeTrackingToGoogleSheets(state, USER_TIMEZONE);
}, {
  timezone: USER_TIMEZONE
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

// Load config from MongoDB and then Start the bot
async function startBot() {
  try {
    await connectDB();

    const commandTopicConfig = await Config.findOne({ key: 'defaultCommandTopic' });
    if (commandTopicConfig && commandTopicConfig.value !== null) state.defaultCommandTopic = Number(commandTopicConfig.value);

    const notificationChatConfig = await Config.findOne({ key: 'defaultNotificationChat' });
    if (notificationChatConfig && notificationChatConfig.value !== null) state.defaultNotificationChat = Number(notificationChatConfig.value);

    const notificationTopicConfig = await Config.findOne({ key: 'defaultNotificationTopic' });
    if (notificationTopicConfig && notificationTopicConfig.value !== null) state.defaultNotificationTopic = Number(notificationTopicConfig.value);

    // Load and schedule notifications from MongoDB
    const dbNotifications = await Notification.find({});
    
    state.notifications = dbNotifications.map(n => ({
      id: n.id,
      cronTime: n.cronTime,
      originalTime: n.originalTime,
      message: n.message,
      chatId: n.chatId,
      topicId: n.topicId
    }));
    
    console.log(`Loaded ${state.notifications.length} notifications from MongoDB`);
    state.notifications.forEach(scheduleNotificationProxy);

    await bot.launch();
    console.log('🤖 Bot is running...');
  } catch (error) {
    console.error('Error during bot startup:', error);
    process.exit(1); // Exit if we can't load config
  }
}

startBot();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 