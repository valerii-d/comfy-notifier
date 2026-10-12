const { AbsenceType } = require('../models');

// Built-in absence types. Texts are fixed here (Ukrainian UI); reminder timings
// are stored in MongoDB and editable by admins with /set_reminder.
// `who` is already-escaped HTML (a mention, optionally with the role).
const TYPES = [
  {
    key: 'out',
    command: 'out',
    emoji: '🚶',
    title: 'Вийшов',
    listTitle: 'Відсутні',
    helpStatus: 'відсутній',
    defaults: { first: 15, repeat: 15 },
    started: (who) => `👋 ${who} вийшов.`,
    ping: (who) => `🔔 ${who} Час повертатись!`
  },
  {
    key: 'lunch',
    command: 'lunch',
    emoji: '🍽️',
    title: 'Обід',
    listTitle: 'На обіді',
    helpStatus: 'на обіді',
    defaults: { first: 30, repeat: 30 },
    started: (who) => `🍽️ ${who} вийшов на обід.`,
    ping: (who) => `🍽️ ${who} Час повертатися з обіду!`
  },
  {
    key: 'break',
    command: 'break',
    emoji: '☕',
    title: 'Коротка перерва',
    listTitle: 'На короткій перерві',
    helpStatus: 'на короткій перерві',
    defaults: { first: 10, repeat: 10 },
    started: (who) => `☕ ${who} вийшов на коротку перерву.`,
    ping: (who) => `☕ ${who} Час повертатися з перерви!`
  }
];

const MIN_REMINDER = 1;
const MAX_REMINDER = 240;

const timings = new Map(); // key -> { firstReminderMin, repeatReminderMin }

// Seeds missing types with defaults, never overwriting admin changes.
async function load() {
  for (const type of TYPES) {
    await AbsenceType.updateOne(
      { key: type.key },
      { $setOnInsert: { key: type.key, firstReminderMin: type.defaults.first, repeatReminderMin: type.defaults.repeat } },
      { upsert: true }
    );
  }
  timings.clear();
  const docs = await AbsenceType.find({ key: { $in: TYPES.map((t) => t.key) } });
  docs.forEach((doc) => timings.set(doc.key, {
    firstReminderMin: doc.firstReminderMin,
    repeatReminderMin: doc.repeatReminderMin
  }));
}

function getType(key) {
  return TYPES.find((t) => t.key === key) || null;
}

function getTimings(key) {
  const type = getType(key);
  return timings.get(key) || { firstReminderMin: type.defaults.first, repeatReminderMin: type.defaults.repeat };
}

async function setTimings(key, firstReminderMin, repeatReminderMin) {
  await AbsenceType.updateOne({ key }, { $set: { firstReminderMin, repeatReminderMin } }, { upsert: true });
  timings.set(key, { firstReminderMin, repeatReminderMin });
}

module.exports = { TYPES, MIN_REMINDER, MAX_REMINDER, load, getType, getTimings, setTimings };
