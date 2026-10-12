const { ActiveAbsence, AbsenceSession } = require('../models');
const absenceTypes = require('./absenceTypes');
const settings = require('./settings');
const { TIMEZONE } = require('../config');
const { currentWorkWindow, workWindow, workDate } = require('../utils/time');

const MINUTE = 60 * 1000;

function workingHours() {
  return { start: settings.get('workDayStart'), end: settings.get('workDayEnd') };
}

// Starts an absence of `typeKey` for `person` ({ userId, username, displayName }).
// ping/reply: { chatId, topicId } for reminders and for status messages.
// Returns { status: 'started' | 'already' | 'outside_hours', absence?, switched? }.
async function startAbsence({ person, typeKey, ping, reply, now = new Date() }) {
  const hours = workingHours();
  const window = currentWorkWindow(now, hours.start, hours.end, TIMEZONE);
  if (!window) return { status: 'outside_hours' };

  let existing = await ActiveAbsence.findOne({ userId: person.userId });
  if (existing && existing.closeAt <= now) {
    // Left over from an earlier work day that the ticker hasn't closed yet.
    await endAbsence(person.userId, 'auto', existing.closeAt);
    existing = null;
  }
  if (existing && existing.type === typeKey) return { status: 'already', absence: existing };

  // Switching type (e.g. /out while at lunch) closes the current absence first.
  const switched = existing ? await endAbsence(person.userId, 'switch', now) : null;

  const { firstReminderMin } = absenceTypes.getTimings(typeKey);
  try {
    const absence = await ActiveAbsence.create({
      userId: person.userId,
      type: typeKey,
      username: person.username,
      displayName: person.displayName,
      startedAt: now,
      closeAt: window.end,
      nextReminderAt: new Date(now.getTime() + firstReminderMin * MINUTE),
      pingChatId: ping.chatId,
      pingTopicId: ping.topicId || null,
      replyChatId: reply.chatId,
      replyTopicId: reply.topicId || null
    });
    return { status: 'started', absence, switched };
  } catch (err) {
    if (err.code === 11000) { // the same user's concurrent command won the race
      return { status: 'already', absence: await ActiveAbsence.findOne({ userId: person.userId }) };
    }
    throw err;
  }
}

// Closes the user's absence and records it as a session. Atomic, so the
// command, the button and the auto-close job can't record it twice.
// Returns { absence, session } or null if the user wasn't away.
async function endAbsence(userId, endedBy, endedAt = new Date()) {
  const absence = await ActiveAbsence.findOneAndDelete({ userId });
  if (!absence) return null;

  // Time after the end of the work day never counts (e.g. returning the next morning).
  const end = new Date(Math.max(absence.startedAt, Math.min(endedAt, absence.closeAt)));
  const session = await AbsenceSession.create({
    userId: absence.userId,
    username: absence.username,
    displayName: absence.displayName,
    type: absence.type,
    startedAt: absence.startedAt,
    endedAt: end,
    durationMs: end - absence.startedAt,
    workDate: workDate(absence.startedAt, TIMEZONE),
    endedBy
  });
  return { absence, session };
}

function listActive() {
  return ActiveAbsence.find({}).sort({ startedAt: 1 });
}

// After the admin changes working hours, move each running absence's close
// time to the new end of its day. Ones already past it close on the next tick.
async function rescheduleCloseTimes(now = new Date()) {
  const hours = workingHours();
  const active = await ActiveAbsence.find({});
  for (const absence of active) {
    const { end } = workWindow(absence.startedAt, hours.start, hours.end, TIMEZONE);
    absence.closeAt = end > absence.startedAt ? end : now;
    await absence.save();
  }
}

module.exports = { startAbsence, endAbsence, listActive, rescheduleCloseTimes, workingHours };
