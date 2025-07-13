#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🤖 Telegram Bot Setup\n');

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setup() {
  try {
    // Check if .env already exists
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const overwrite = await question('.env file already exists. Overwrite? (y/N): ');
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Setup cancelled.');
        rl.close();
        return;
      }
    }

    console.log('\n📋 Setup Instructions:');
    console.log('1. Go to @BotFather on Telegram');
    console.log('2. Send /newbot command');
    console.log('3. Follow instructions to create your bot');
    console.log('4. Copy the bot token\n');

    const botToken = await question('Enter your bot token: ');
    
    if (!botToken || botToken === 'your_bot_token_here') {
      console.log('❌ Invalid bot token. Please provide a valid token.');
      rl.close();
      return;
    }

    const defaultAdmin = await question('Enter your Telegram user ID (optional, press Enter to skip): ');
    const additionalAdmins = await question('Enter additional admin IDs separated by commas (optional, press Enter to skip): ');
    
    const userTimezone = await question('Введіть таймзону користувача (за замовчуванням Europe/Kiev): ');
    const googleKeyFile = await question('Введіть шлях до файлу ключа Google Service Account (за замовчуванням service-account-key.json): ');
    const googleSpreadsheetId = await question('Введіть ID Google Spreadsheet для збереження даних (опціонально, натисніть Enter для пропуску): ');
    const commandChatId = await question('Введіть Chat ID для відповідей на команди (опціонально, натисніть Enter для пропуску): ');

    const tzUser = userTimezone && userTimezone.trim() ? userTimezone.trim() : 'Europe/Kiev';
    const keyFile = googleKeyFile && googleKeyFile.trim() ? googleKeyFile.trim() : 'service-account-key.json';

    let envContent = `# Telegram Bot Token (get from @BotFather)\nBOT_TOKEN=${botToken}\n`;
    envContent += `USER_TIMEZONE=${tzUser}\n`;
    envContent += `GOOGLE_SERVICE_ACCOUNT_KEY=${keyFile}\n`;
    
    if (googleSpreadsheetId && googleSpreadsheetId.trim()) {
      envContent += `GOOGLE_SPREADSHEET_ID=${googleSpreadsheetId.trim()}\n`;
    }
    
    if (commandChatId && commandChatId.trim()) {
      envContent += `DEFAULT_COMMAND_CHAT_ID=${commandChatId.trim()}\n`;
    }
    
    if (defaultAdmin && defaultAdmin !== 'your_telegram_user_id_here') {
      let adminIds = defaultAdmin;
      if (additionalAdmins && additionalAdmins.trim()) {
        adminIds += ',' + additionalAdmins.trim();
      }
      envContent += `\n# Default Admin IDs (optional - comma-separated list of Telegram user IDs)\nDEFAULT_ADMIN_ID=${adminIds}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    
    console.log('\n✅ Setup completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Add the bot to your Telegram group');
    console.log('2. Make the bot an admin (recommended)');
    console.log('3. Create a group topic for the bot to work in');
    console.log('4. Run: npm start');
    console.log('\n📖 For more information, see README.md');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
  } finally {
    rl.close();
  }
}

setup(); 