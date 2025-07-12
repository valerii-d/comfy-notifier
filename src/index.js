require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');

// Bot token from environment variables
const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory storage (in production, use a database)
const state = {
  admins: new Set(),
  notifications: [],
  usersOut: new Map(), // userId -> { timestamp, chatId, messageId }
  dutyUsers: new Set(),
  defaultNotificationChat: null, // Default chat for notifications
  defaultNotificationTopic: null // Default topic for notifications
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
  ctx.reply('Welcome to the Notification Bot! Use /help to see available commands.');
});

// Help command
bot.help((ctx) => {
  const isInGroup = ctx.chat.type === 'supergroup' || ctx.chat.type === 'group';
  const isAdminUser = isAdmin(ctx);
  
  if (isInGroup) {
    // In groups, only show user commands
    const helpText = `
🤖 Bot Commands (Group):

📋 Команди користувача:
/out - Відмітьте, що ви вийшли
/lunch - Відмітьте, що ви вийшли на обід
/on_duty - Відмітьте, що ви повернулись

📝 Примітка: Ці команди працюють виключно у групових чатах.
    `;
    ctx.reply(helpText);
  } else if (isAdminUser) {
    // In private chat with admin, show all commands
    const helpText = `
🤖 Bot Commands (Admin):

📋 Команди користувача:
/out - Відмітьте, що ви вийшли
/lunch - Відмітьте, що ви вийшли на обід
/on_duty - Відмітьте, що ви повернулись

👑 Команди адміна:
/admin_panel - Відкрити панель адміністратора
/add_notification - Додати нове нагадування
/delete_notification - Видалити нагадування
/set_notification_target - Встановити групу/чат для нагадувань
/notification_target - Перевірити активну групу/чат для нагадувань
/add_admin - Додати нового адміна
/delete_admin - Видалити адміна

📝 Примітка: Команди користувача дійсні лише в групових чатах
    `;
    ctx.reply(helpText);
  } else {
    // In private chat with non-admin, show limited info
    const helpText = `
🤖 Bot Commands:

📋 Командик користувача:
/out - Відмітьте, що ви вийшли
/lunch - Відмітьте, що ви вийшли на обід
/on_duty - Відмітьте, що ви повернулись

📝 Примітка: Команди користувача дійсні лише в групових чатах.
Звʼяжіться з адміністратором для додаткових функцій.
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

  ctx.reply(`👋 ${username} вийшов. Пінганемо через 15 хвилин, якщо не повернешся.`);
  
  // Schedule first ping in 15 minutes
  setTimeout(() => {
    pingUserIfStillOut(userId);
  }, 15 * 60 * 1000);
});

bot.command('lunch', (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const username = ctx.from.username || ctx.from.first_name;
  ctx.reply(`🍽️ ${username} is on lunch break.`);
});

bot.command('on_duty', (ctx) => {
  if (!isGroupTopic(ctx)) {
    return ctx.reply('Ця команда доступна лише в групових чатах ');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Remove from out users and add to duty users
  state.usersOut.delete(userId);
  state.dutyUsers.add(userId);

  ctx.reply(`✅ ${username} повернувся!`);
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
    [Markup.button.callback('➕ Add Notification', 'add_notification')],
    [Markup.button.callback('🗑️ Delete Notification', 'delete_notification')],
    [Markup.button.callback('📍 Set Notification Target', 'set_notification_target')],
    [Markup.button.callback('👑 Add Admin', 'add_admin')],
    [Markup.button.callback('❌ Remove Admin', 'remove_admin')],
    [Markup.button.callback('📋 View Notifications', 'view_notifications')],
    [Markup.button.callback('👥 View Admins', 'view_admins')]
  ]);

  ctx.reply('🔧 Admin Panel', adminPanel);
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
    ctx.reply('To add an admin, reply to their message with /add_admin or use:\n/add_admin <user_id>');
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
    
    ctx.reply('Для додавання чату для сповіщень, використовуйте наступний формат:\n/set_notification_target <chat_id> [topic_id]\n\nПриклад:\n/set_notification_target -1001234567890\n/set_notification_target -1001234567890 123\n\nЩоб отримати chat ID, перешліть повідомлення з чату в @userinfobot');
  }
  
  else if (action === 'im_back') {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    // Remove from out users and add to duty users
    state.usersOut.delete(userId);
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
});

// Admin command handlers
bot.command('add_notification', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('У вас не має прав адміністратора');
  }

  // Only allow in private chats
  if (ctx.chat.type !== 'private') {
    return ctx.reply('Ця команда доступна лише в особистих повідомленнях з ботом.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /add_notification <time> <message>\nExample: /add_notification "09:30" "Good morning team!"');
  }

  const timeInput = args[0].replace(/^["']|["']$/g, ''); // Remove quotes if present
  const message = args.slice(1).join(' ');

  // Parse time format (HH:MM)
  const timeRegex = /^(\d{1,2}):(\d{2})$/;
  const timeMatch = timeInput.match(timeRegex);

  if (!timeMatch) {
    return ctx.reply('Невірний формат часу. Будь ласка, використовуйте формат HH:MM (наприклад, 09:30, 14:15, 18:00)');
  }

  const hour = parseInt(timeMatch[1]);
  const minute = parseInt(timeMatch[2]);

  // Validate hour and minute ranges
  if (hour < 0 || hour > 23) {
    return ctx.reply('Невірно вказано години. Будь ласка, використовуйте формат 0-23 для годин.');
  }
  if (minute < 0 || minute > 59) {
    return ctx.reply('Невірно вказано хвилини. Будь ласка, використовуйте формат 0-59 для хвилин.');
  }

  // Convert to cron expression (minute hour * * *)
  const cronTime = `${minute} ${hour} * * *`;

  // Check if default notification target is set
  if (!state.defaultNotificationChat) {
    return ctx.reply('❌ Не вказано чат для сповіщень. Будь ласка, скористайтесь панелю адміністратора та встановіть чат для сповіщень.');
  }

  const notification = {
    id: Date.now(),
    cronTime: cronTime,
    originalTime: timeInput, // Store original time for display
    message: message,
    chatId: state.defaultNotificationChat,
    topicId: state.defaultNotificationTopic
  };

  state.notifications.push(notification);

  // Schedule the notification
  scheduleNotification(notification);

  ctx.reply(`✅ Сповіщення успішно додано!\ Час: ${timeInput} (кожень день)\n Повідомлення: ${message}`);
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
    
    ctx.reply(`✅ Ціль сповіщення встановлено: ${chatInfo}${topicInfo}\n\nВсі сповіщення будуть відправлятися до цього чату/topic.`);
  }).catch((error) => {
    ctx.reply(`❌ Помилка при встановленні цілі сповіщення: ${error.description}\n\n Переконайтесь:\n1. Бота додано до групи\n2. Сhat ID вказано вірно\n3. Topic ID вірний (якщо вказано)`);
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
    return ctx.reply('❌ Не встановлено цілі для сповіщення. Використовуйте команду /set_notification_target для встановлення цілі.');
  }

  const chatInfo = `Chat ID: ${state.defaultNotificationChat}`;
  const topicInfo = state.defaultNotificationTopic ? `\nTopic ID: ${state.defaultNotificationTopic}` : '\nЧат: Загальний чат (не уточнено чат)';
  
  ctx.reply(`📍 Current notification target:\n${chatInfo}${topicInfo}`);
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
      `❌ Remove Admin ${adminId}`,
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
    
    bot.telegram.sendMessage(notification.chatId, notification.message, messageOptions);
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
  );

  // Schedule next ping in 15 minutes
  setTimeout(() => {
    pingUserIfStillOut(userId);
  }, 15 * 60 * 1000);
}

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