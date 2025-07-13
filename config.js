// Configuration file for the Telegram bot
module.exports = {
  // Bot settings
  bot: {
    // Polling timeout (in seconds)
    pollingTimeout: 30,
    // Webhook settings (if using webhooks)
    webhook: {
      enabled: false,
      domain: process.env.WEBHOOK_DOMAIN,
      port: process.env.WEBHOOK_PORT || 3000
    }
  },
  
  // Notification settings
  notifications: {
    // Maximum number of notifications per chat
    maxPerChat: 50
  },
  
  // Duty tracking settings
  duty: {
    // Ping interval in minutes
    pingInterval: 15,
    // Maximum pings before stopping (0 = unlimited)
    maxPings: 0
  },
  
  // Admin settings
  admin: {
    // Maximum number of admins
    maxAdmins: 10
  }
}; 