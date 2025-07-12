# Telegram Notification Bot

A Telegram bot built with Telegraf.js that provides group notification management and duty tracking functionality.

## Features

### 🚨 User Commands (Group Topics Only)
- `/out` - Mark yourself as out (will be pinged every 15 minutes until back on duty)
- `/lunch` - Mark yourself as on lunch break
- `/on_duty` - Mark yourself as back on duty

### 👑 Admin Commands
- `/admin_panel` - Open admin control panel
- `/add_notification` - Add scheduled notifications
- `/delete_notification` - Remove scheduled notifications
- `/add_admin` - Add new admin users
- `/delete_admin` - Remove admin users

### 📅 Notification System
- Schedule notifications using cron expressions
- Multiple notifications can be set
- Notifications are sent to group topics

### 🔔 Duty Tracking
- Automatic ping system for users marked as "out"
- 15-minute intervals between pings
- "I'm back" button for quick return to duty

## Setup

### 1. Create a Telegram Bot
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` command
3. Follow instructions to create your bot
4. Copy the bot token

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory:
```env
# Telegram Bot Token (get from @BotFather)
BOT_TOKEN=your_bot_token_here

# Default Admin IDs (optional - comma-separated list of Telegram user IDs)
DEFAULT_ADMIN_ID=123456789,987654321,555666777
```

### 4. Run the Bot
```bash
# Production
npm start

# Development (with auto-restart)
npm run dev
```

## Usage

### Adding the Bot to a Group
1. Add the bot to your Telegram group
2. Make the bot an admin (optional but recommended)
3. Create a group topic for the bot to work in

### Setting Up Admins
1. Use `/admin_panel` to open admin controls
2. Click "Add Admin" or use `/add_admin <user_id>`
3. Reply to a message with `/add_admin` to add that user

### Setting Up Notifications
1. **Set Notification Target**: Use `/set_notification_target <chat_id> [topic_id]`
   - Example: `/set_notification_target -1001234567890` (general chat)
   - Example: `/set_notification_target -1001234567890 123` (specific topic)
   - To get chat ID: forward a message from that group to @userinfobot
2. **Add Notifications**: Use `/admin_panel` → "Add Notification" or `/add_notification <HH:MM> <message>`
3. **Example**: `/add_notification "09:30" "Good morning team!"`

**Note**: You must set a notification target before adding notifications.

### Time Format Examples
- `"09:30"` - Every day at 9:30 AM
- `"14:15"` - Every day at 2:15 PM
- `"18:00"` - Every day at 6:00 PM
- `"00:00"` - Every day at midnight

### Duty Tracking
1. Users use `/out` when leaving
2. Bot automatically pings every 15 minutes
3. Users can return with `/on_duty` or "I'm back" button
4. `/lunch` for temporary breaks

## Commands Reference

### User Commands
| Command | Description |
|---------|-------------|
| `/out` | Mark yourself as out |
| `/lunch` | Mark yourself as on lunch break |
| `/on_duty` | Mark yourself as back on duty |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/admin_panel` | Open admin control panel |
| `/add_notification <HH:MM> <message>` | Add daily notification |
| `/delete_notification` | Remove scheduled notification |
| `/set_notification_target <chat_id> [topic_id]` | Set notification target |
| `/notification_target` | Check current notification target |
| `/add_admin <user_id>` | Add new admin |
| `/delete_admin` | Remove admin |

## Technical Details

- **Framework**: Telegraf.js
- **Scheduling**: node-cron
- **Storage**: In-memory (resets on restart)
- **Node.js**: v14+ required

## Production Considerations

For production use, consider:
- Using a database instead of in-memory storage
- Adding proper error handling and logging
- Implementing rate limiting
- Using environment-specific configurations
- Adding monitoring and health checks

## License

MIT License 