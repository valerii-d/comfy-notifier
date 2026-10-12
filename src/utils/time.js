const moment = require('moment-timezone');

const MINUTES_PER_DAY = 24 * 60;

// "09:30" -> 570. "24:00" is accepted as end of day (1440). Returns null if invalid.
function parseHHMM(str) {
  const match = /^"?(\d{1,2}):(\d{2})"?$/.exec(String(str).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// A moment at `minutes` past local midnight of `day`. set() rather than add() keeps
// wall-clock times right on DST change days.
function atMinutes(day, minutes) {
  if (minutes >= MINUTES_PER_DAY) return day.clone().add(1, 'day').startOf('day');
  return day.clone().set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

// Work-day window on the local calendar day of `date`.
function workWindow(date, startMin, endMin, tz) {
  const day = moment.tz(date, tz).startOf('day');
  return {
    start: atMinutes(day, startMin).toDate(),
    end: atMinutes(day, endMin).toDate()
  };
}

// The window `now` falls into, or null outside working hours.
function currentWorkWindow(now, startMin, endMin, tz) {
  const window = workWindow(now, startMin, endMin, tz);
  return now >= window.start && now < window.end ? window : null;
}

function workDate(date, tz) {
  return moment.tz(date, tz).format('YYYY-MM-DD');
}

// Monday 00:00 of the ISO week containing `date`.
function weekStart(date, tz) {
  return moment.tz(date, tz).startOf('isoWeek').toDate();
}

// The last fully finished Monday–Sunday week before `now`.
function previousWeek(now, tz) {
  const end = moment.tz(now, tz).startOf('isoWeek');
  return { start: end.clone().subtract(1, 'week').toDate(), end: end.toDate() };
}

function formatDate(date, tz) {
  return moment.tz(date, tz).format('DD.MM.YYYY');
}

function formatTime(date, tz) {
  return moment.tz(date, tz).format('HH:mm');
}

// Ukrainian plural: pluralUk(5, ['хвилину', 'хвилини', 'хвилин']) -> 'хвилин'
function pluralUk(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function minutesUk(n) {
  return `${n} ${pluralUk(n, ['хвилину', 'хвилини', 'хвилин'])}`;
}

module.exports = {
  MINUTES_PER_DAY,
  parseHHMM, formatHHMM,
  workWindow, currentWorkWindow, workDate,
  weekStart, previousWeek,
  formatDate, formatTime,
  pluralUk, minutesUk
};
