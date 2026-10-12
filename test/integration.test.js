// End-to-end: real MongoDB, fake Telegram API (no network, no bot token).
// Run against the compose MongoDB:
//   MONGODB_TEST_URI="mongodb://comfy:<password>@127.0.0.1:27017/?authSource=admin" npm test
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const uri = process.env.MONGODB_TEST_URI;
if (!uri) {
  test('integration tests (set MONGODB_TEST_URI to run)', { skip: true }, () => {});
  return;
}

process.env.USER_TIMEZONE = 'Europe/Kyiv';
const ADMIN = { id: 1000, is_bot: false, first_name: 'Admin', username: 'boss' };
const ALICE = { id: 1, is_bot: false, first_name: 'Alice', username: 'alice' };
const BOB = { id: 2, is_bot: false, first_name: 'Bob' }; // no username
const DAVE = { id: 4, is_bot: false, first_name: 'Dave', username: 'Dave_K' };
const GROUP = -100500;
const TOPIC = 77;

const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const { Telegram } = require('telegraf');
const models = require('../src/models');
const settings = require('../src/services/settings');
const admins = require('../src/services/admins');
const absenceTypes = require('../src/services/absenceTypes');
const notifications = require('../src/services/notifications');
const reminders = require('../src/services/reminders');
const weeklyReport = require('../src/services/weeklyReport');
const { createBot } = require('../src/bot');

const { ActiveAbsence, AbsenceSession, ReportRun, User, Admin } = models;

// --- fake Telegram -----------------------------------------------------------
let calls = [];
let failingRecipients = new Set();
let messageId = 0;
Telegram.prototype.callApi = async function callApi(method, payload) {
  calls.push({ method, payload });
  if (method === 'sendMessage') return { message_id: ++messageId, date: 0, chat: { id: payload.chat_id }, text: payload.text };
  if (method === 'getChat') return { id: payload.chat_id, type: 'supergroup', title: 'Team' };
  if (method === 'sendChatAction' && payload.chat_id === 3000) {
    throw Object.assign(new Error('Forbidden'), { description: "Forbidden: bot can't initiate conversation with a user" });
  }
  if (method === 'sendDocument') {
    if (failingRecipients.has(payload.chat_id)) throw Object.assign(new Error('Forbidden'), { description: 'Forbidden: bot was blocked by the user' });
    return { message_id: ++messageId };
  }
  return true;
};
const sent = (method) => calls.filter((c) => c.method === method);
const lastText = () => sent('sendMessage').at(-1)?.payload.text;

// --- fake updates ------------------------------------------------------------
let bot;
let updateId = 0;
const entity = (text) => [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];

function groupCommand(from, text, { topic = TOPIC } = {}) {
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++messageId, date: Math.floor(Date.now() / 1000), from, text, entities: entity(text),
      chat: { id: GROUP, type: 'supergroup', title: 'Team', is_forum: true },
      ...(topic ? { message_thread_id: topic, is_topic_message: true } : {})
    }
  });
}

function privateCommand(from, text) {
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++messageId, date: Math.floor(Date.now() / 1000), from, text, entities: entity(text),
      chat: { id: from.id, type: 'private', first_name: from.first_name }
    }
  });
}

function press(from, data, chatId = GROUP) {
  return bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`, from, chat_instance: '1', data,
      message: { message_id: ++messageId, date: 0, chat: { id: chatId, type: 'supergroup' }, text: 'old' }
    }
  });
}

const answers = () => sent('answerCallbackQuery').map((c) => c.payload);

async function loadServices() {
  await settings.load();
  await admins.load([ADMIN.id]);
  await absenceTypes.load();
  await notifications.load(bot.telegram);
}

before(async () => {
  await mongoose.connect(uri, { dbName: 'comfy_notifier_test', autoIndex: false }); // as in src/config/db.js
  await mongoose.connection.dropDatabase();
  // Index left behind by the old schema (Atlas data): must be replaced on startup.
  await User.collection.createIndex({ username: 1 }, { unique: true });
  await Promise.all(Object.values(models).map((m) => m.syncIndexes()));

  bot = createBot('123:TEST');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Comfy', username: 'comfy_test_bot' };
  await loadServices();
});

after(async () => {
  await notifications.clear();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(() => {
  calls = [];
});

test('startup replaced the old unique username index', async () => {
  const indexes = await User.collection.indexes();
  const usernameIndex = indexes.find((i) => i.name === 'username_1');
  assert.ok(usernameIndex);
  assert.notEqual(usernameIndex.unique, true);
});

test('/out announces, stores the absence and schedules a reminder', async () => {
  await groupCommand(ALICE, '/out');
  const msg = sent('sendMessage').at(-1).payload;
  assert.equal(msg.chat_id, GROUP);
  assert.equal(msg.message_thread_id, TOPIC);
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /👋 @alice вийшов\. Пінганемо через 15 хвилин/);
  assert.match(msg.text, /🚶 Відсутні:\n  🔹 Без ролі: @alice/);

  const active = await ActiveAbsence.findOne({ userId: ALICE.id });
  assert.equal(active.type, 'out');
  assert.equal(active.nextReminderAt - active.startedAt, 15 * 60 * 1000);
});

test('repeating the same command does not start a second absence', async () => {
  await groupCommand(ALICE, '/out@comfy_test_bot');
  assert.match(lastText(), /Ви вже відмічені: «Вийшов»/);
  assert.equal(await ActiveAbsence.countDocuments({ userId: ALICE.id }), 1);
});

test('/break while out switches type and records the finished absence', async () => {
  await groupCommand(ALICE, '/break');
  assert.match(lastText(), /☕ @alice вийшов на коротку перерву\. Пінганемо через 10 хвилин/);
  assert.match(lastText(), /☕ На короткій перерві:/);
  assert.doesNotMatch(lastText(), /🚶 Відсутні/);

  const session = await AbsenceSession.findOne({ userId: ALICE.id });
  assert.equal(session.type, 'out');
  assert.equal(session.endedBy, 'switch');
  assert.equal((await ActiveAbsence.findOne({ userId: ALICE.id })).type, 'break');
});

test('users without a username are mentioned by link', async () => {
  await groupCommand(BOB, '/lunch');
  assert.match(lastText(), /🍽️ <a href="tg:\/\/user\?id=2">Bob<\/a> вийшов на обід\. Пінганемо через 30 хвилин/);
});

test('commands outside a forum topic are rejected', async () => {
  await groupCommand(ALICE, '/out', { topic: null });
  assert.match(lastText(), /лише в темі \(топіку\)/);
});

test('due reminder is sent once with a personal "I am back" button', async () => {
  await ActiveAbsence.updateOne({ userId: ALICE.id }, { $set: { nextReminderAt: new Date(Date.now() - 1000) } });
  await reminders.tick(bot.telegram);
  await reminders.tick(bot.telegram); // second tick must not repeat it

  const pings = sent('sendMessage').filter((c) => /Час повертатися з перерви/.test(c.payload.text));
  assert.equal(pings.length, 1);
  assert.equal(pings[0].payload.text, '☕ @alice Час повертатися з перерви!');
  assert.equal(pings[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'back:1');

  const active = await ActiveAbsence.findOne({ userId: ALICE.id });
  assert.equal(active.remindersSent, 1);
  assert.ok(active.nextReminderAt > new Date(Date.now() + 9 * 60 * 1000)); // repeat: 10 min
});

test('only the reminded user can press their button', async () => {
  await press(BOB, 'back:1');
  assert.equal(answers().at(-1).show_alert, true);
  assert.ok(await ActiveAbsence.findOne({ userId: ALICE.id }));

  await press(ALICE, 'back:1');
  assert.equal(await ActiveAbsence.findOne({ userId: ALICE.id }), null);
  const session = await AbsenceSession.findOne({ userId: ALICE.id, type: 'break' });
  assert.equal(session.endedBy, 'button');
  assert.match(sent('editMessageText').at(-1).payload.text, /✅ @alice повернувся!/);
});

test('absences still open at the end of the work day are auto-closed', async () => {
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const closeAt = new Date(Date.now() - 60 * 1000);
  await ActiveAbsence.updateOne({ userId: BOB.id }, { $set: { startedAt, closeAt } });
  await reminders.tick(bot.telegram);

  assert.equal(await ActiveAbsence.findOne({ userId: BOB.id }), null);
  const session = await AbsenceSession.findOne({ userId: BOB.id });
  assert.equal(session.endedBy, 'auto');
  assert.equal(session.endedAt.getTime(), closeAt.getTime());
  assert.equal(session.durationMs, closeAt - startedAt);
  assert.match(lastText(), /🌙 Робочий день завершено\. Автоматично закрито відсутності:\n• <a href="tg:\/\/user\?id=2">Bob<\/a> — Обід/);
});

test('/on_duty records the absence and announces the return', async () => {
  await groupCommand(ALICE, '/lunch');
  await groupCommand(ALICE, '/on_duty');
  assert.equal(lastText(), '✅ @alice повернувся!');
  assert.equal((await AbsenceSession.find({ userId: ALICE.id, type: 'lunch', endedBy: 'command' })).length, 1);
});

test('admin commands are refused for non-admins', async () => {
  await privateCommand(ALICE, '/set_reminder break 5');
  assert.match(lastText(), /немає прав адміністратора/);
  await groupCommand(ADMIN, '/set_reminder break 5');
  assert.match(lastText(), /лише в особистих повідомленнях/);
});

test('/set_reminder changes timings and survives a restart', async () => {
  await privateCommand(ADMIN, '/set_reminder break 5 7');
  assert.match(lastText(), /перше нагадування через 5 хвилин, далі кожні 7 хв/);
  await privateCommand(ADMIN, '/set_reminder break 0');
  assert.match(lastText(), /від 1 до 240/);

  await loadServices(); // simulate restart
  assert.deepEqual(absenceTypes.getTimings('break'), { firstReminderMin: 5, repeatReminderMin: 7 });
  await privateCommand(ADMIN, '/reminders');
  assert.match(lastText(), /☕ Коротка перерва \(break\): перше нагадування через 5 хвилин, далі кожні 7 хв/);
});

test('working hours: absences are refused outside them', async () => {
  await privateCommand(ADMIN, '/set_workday 18:00 09:00');
  assert.match(lastText(), /Початок має бути раніше/);

  await privateCommand(ADMIN, '/set_workday 23:58 23:59');
  await groupCommand(BOB, '/out');
  assert.match(lastText(), /⏰ Зараз неробочий час\. Робочий день: 23:58–23:59/);

  await privateCommand(ADMIN, '/set_workday 00:00 24:00');
  assert.deepEqual([settings.get('workDayStart'), settings.get('workDayEnd')], [0, 1440]);
});

test('changing working hours moves the close time of running absences', async () => {
  await groupCommand(BOB, '/out');
  await privateCommand(ADMIN, '/set_workday 00:00 00:01');
  const active = await ActiveAbsence.findOne({ userId: BOB.id });
  assert.ok(active.closeAt <= new Date());
  await reminders.tick(bot.telegram);
  assert.equal(await ActiveAbsence.findOne({ userId: BOB.id }), null);
  await privateCommand(ADMIN, '/set_workday 00:00 24:00');
});

test('roles assigned by username are picked up on first contact', async () => {
  await privateCommand(ADMIN, '/add_role Tester');
  await privateCommand(ADMIN, '/assign_role @dave_k Tester');
  assert.match(lastText(), /призначено роль "Tester"/);
  await groupCommand(DAVE, '/out');
  assert.match(lastText(), /👋 @Dave_K \(Tester\) вийшов/);
  const dave = await User.findOne({ userId: DAVE.id });
  assert.equal(dave.role, 'Tester');
  await groupCommand(DAVE, '/on_duty');
});

test('a leftover absence from an earlier day is closed at that day\'s end, not counted overnight', async () => {
  const startedAt = new Date(Date.now() - 20 * 3600 * 1000);
  const closeAt = new Date(Date.now() - 14 * 3600 * 1000);
  await ActiveAbsence.create({
    userId: DAVE.id, type: 'out', username: 'Dave_K', displayName: 'Dave',
    startedAt, closeAt, nextReminderAt: null, pingChatId: GROUP, replyChatId: GROUP
  });

  await groupCommand(DAVE, '/out'); // same type, but stale: must start a fresh absence
  assert.match(lastText(), /👋 @Dave_K \(Tester\) вийшов/);
  const stale = await AbsenceSession.findOne({ userId: DAVE.id, endedBy: 'auto' });
  assert.equal(stale.durationMs, closeAt - startedAt);

  await groupCommand(DAVE, '/on_duty');
});

test('notifications: add, list, delete by id', async () => {
  await privateCommand(ADMIN, '/add_notification 09:30 Hi');
  assert.match(lastText(), /Ціль для сповіщень не встановлена/);

  await privateCommand(ADMIN, `/set_notification_target ${GROUP} ${TOPIC}`);
  assert.match(lastText(), /Ціль для сповіщень встановлено: Team \(topic ID: 77\)/);
  await privateCommand(ADMIN, '/add_notification "09:30" Доброго ранку, команда!');
  assert.match(lastText(), /Час: 09:30 \(Europe\/Kyiv\)\nПовідомлення: Доброго ранку, команда!/);

  const [notification] = notifications.list();
  assert.equal(notification.cronTime, '30 9 * * *');
  await press(ADMIN, `delete_notif:${notification.id}`, ADMIN.id);
  assert.equal(notifications.list().length, 0);
  assert.equal(await models.Notification.countDocuments(), 0);
});

test('reminders go to the notification target once it is set', async () => {
  await groupCommand(ALICE, '/break');
  const active = await ActiveAbsence.findOne({ userId: ALICE.id });
  assert.equal(active.pingChatId, GROUP);
  assert.equal(active.pingTopicId, TOPIC);
  await groupCommand(ALICE, '/on_duty');
});

test('admins added through the bot persist; recipients warn when the bot cannot DM', async () => {
  await privateCommand(ADMIN, '/add_admin 2000');
  await privateCommand(ADMIN, '/add_admin 3000');
  assert.ok(await Admin.findOne({ userId: 2000 }));
  await loadServices(); // simulate restart
  assert.equal(admins.isAdmin(2000), true);

  await press(ADMIN, 'rcpt:2000', ADMIN.id);
  assert.equal(answers().at(-1).show_alert, undefined);
  await press(ADMIN, 'rcpt:3000', ADMIN.id);
  assert.equal(answers().at(-1).show_alert, true); // never pressed Start
  assert.deepEqual(settings.get('reportRecipients'), [2000, 3000]);

  await press(ADMIN, 'rcpt:3000', ADMIN.id); // toggle off
  assert.deepEqual(settings.get('reportRecipients'), [2000]);
});

test('weekly report: failed delivery keeps data, success sends the file and wipes', async () => {
  // A known 45-minute lunch for Alice inside the current week.
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await AbsenceSession.create({
    userId: ALICE.id, username: 'alice', displayName: 'Alice', type: 'lunch', startedAt,
    endedAt: new Date(startedAt.getTime() + 45 * 60 * 1000), durationMs: 45 * 60 * 1000,
    workDate: require('../src/utils/time').workDate(startedAt, 'Europe/Kyiv'), endedBy: 'command'
  });
  const sessionsBefore = await AbsenceSession.countDocuments();
  const nextMonday = new Date(require('../src/utils/time').weekStart(new Date(), 'Europe/Kyiv').getTime() + 7 * 24 * 3600 * 1000 + 60 * 1000);

  failingRecipients = new Set([2000]);
  let result = await weeklyReport.sendWeeklyReport(bot.telegram, { now: nextMonday });
  assert.equal(result.status, 'failed');
  assert.equal(await AbsenceSession.countDocuments(), sessionsBefore);

  failingRecipients = new Set();
  calls = [];
  result = await weeklyReport.sendWeeklyReport(bot.telegram, { now: nextMonday });
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.delivered, [2000]);
  assert.equal(await AbsenceSession.countDocuments(), 0);
  assert.equal((await ReportRun.findOne({})).status, 'sent');

  const doc = sent('sendDocument')[0].payload;
  assert.equal(doc.chat_id, 2000);
  assert.match(doc.document.filename, /^absences_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(doc.caption, /Звіт про відсутності за/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(doc.document.source);
  const week = workbook.getWorksheet('Тиждень');
  const aliceRow = [5, 6, 7, 8].map((r) => week.getRow(r).values.slice(1)).find((v) => v[0] === 'Alice (@alice)');
  assert.ok(aliceRow, 'Alice is in the weekly sheet');
  assert.equal(aliceRow[3], 45); // lunch minutes

  result = await weeklyReport.sendWeeklyReport(bot.telegram, { now: nextMonday });
  assert.equal(result.status, 'already');
});

test('/report_now sends the week-to-date file to the requesting admin', async () => {
  await privateCommand(ADMIN, '/report_now');
  assert.equal(lastText(), 'За поточний тиждень ще немає завершених відсутностей.');

  await groupCommand(ALICE, '/out');
  await groupCommand(ALICE, '/on_duty');
  calls = [];
  await privateCommand(ADMIN, '/report_now');
  const doc = sent('sendDocument')[0].payload;
  assert.equal(doc.chat_id, ADMIN.id);
  assert.match(doc.caption, /Звіт за поточний тиждень/);
  assert.equal(await AbsenceSession.countDocuments(), 1); // nothing wiped
});
