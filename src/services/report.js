const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const { AbsenceSession } = require('../models');
const absenceTypes = require('./absenceTypes');
const { rolesByUserId } = require('./users');
const { label } = require('../telegram/format');

const DAY_NAMES = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // indexed by moment().day()

// Total duration per user / work day / absence type for sessions started in [from, to).
// `from` may be null to include everything older than `to`.
async function collect({ from = null, to }) {
  const startedAt = { $lt: to };
  if (from) startedAt.$gte = from;

  const groups = await AbsenceSession.aggregate([
    { $match: { startedAt } },
    { $sort: { startedAt: 1 } },
    {
      $group: {
        _id: { userId: '$userId', workDate: '$workDate', type: '$type' },
        durationMs: { $sum: '$durationMs' },
        username: { $last: '$username' },
        displayName: { $last: '$displayName' }
      }
    }
  ]);

  const roles = await rolesByUserId([...new Set(groups.map((g) => g._id.userId))]);
  return groups.map((g) => ({
    userId: g._id.userId,
    workDate: g._id.workDate,
    type: g._id.type,
    durationMs: g.durationMs,
    username: g.username,
    displayName: g.displayName,
    role: roles.get(g._id.userId) || null
  }));
}

const toMinutes = (ms) => Math.round(ms / 60000);

// Pure: aggregated rows -> per-day rows and per-user weekly totals, in whole
// minutes. Weekly totals are sums of the rounded daily values so both sheets agree.
function buildReportData(rows, typeKeys = absenceTypes.TYPES.map((t) => t.key)) {
  const people = new Map(); // userId -> { userId, label, role }
  const days = new Map(); // `${workDate}|${userId}` -> { workDate, userId, ms: { type: ms } }

  for (const row of rows) {
    if (!typeKeys.includes(row.type)) continue;
    people.set(row.userId, { userId: row.userId, label: label(row), role: row.role });
    const key = `${row.workDate}|${row.userId}`;
    if (!days.has(key)) days.set(key, { workDate: row.workDate, userId: row.userId, ms: {} });
    const day = days.get(key);
    day.ms[row.type] = (day.ms[row.type] || 0) + row.durationMs;
  }

  const byLabel = (a, b) => a.label.localeCompare(b.label, 'uk');

  const dayRows = [...days.values()].map((day) => {
    const person = people.get(day.userId);
    const minutes = Object.fromEntries(typeKeys.map((k) => [k, toMinutes(day.ms[k] || 0)]));
    return { workDate: day.workDate, userId: day.userId, label: person.label, role: person.role, minutes };
  }).sort((a, b) => a.workDate.localeCompare(b.workDate) || byLabel(a, b));

  const users = [...people.values()].map((person) => {
    const minutes = Object.fromEntries(typeKeys.map((k) => [k, 0]));
    for (const day of dayRows) {
      if (day.userId !== person.userId) continue;
      typeKeys.forEach((k) => { minutes[k] += day.minutes[k]; });
    }
    return { ...person, minutes };
  }).sort(byLabel);

  return { users, days: dayRows };
}

function styleHeader(row) {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA9B8' } } };
  });
}

function columnLetter(index) { // 1-based, enough for our < 26 columns
  return String.fromCharCode(64 + index);
}

// Builds the .xlsx file. periodStart/periodEnd are display strings (DD.MM.YYYY).
async function buildWorkbook({ data, periodStart, periodEnd }) {
  const types = absenceTypes.TYPES;
  const typeHeaders = types.map((t) => `${t.title}, хв`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'comfy-notifier';
  workbook.created = new Date();

  // Sheet 1 — weekly totals per user.
  const week = workbook.addWorksheet('Тиждень', { views: [{ state: 'frozen', ySplit: 4 }] });
  week.columns = [{ width: 34 }, { width: 18 }, ...types.map(() => ({ width: 18 }))];
  week.getCell('A1').value = 'Відсутності за тиждень';
  week.getCell('A1').font = { bold: true, size: 14 };
  week.getCell('A2').value = `Період: ${periodStart} – ${periodEnd}`;
  week.getRow(4).values = ['Користувач', 'Роль', ...typeHeaders];
  styleHeader(week.getRow(4));

  const firstDataRow = 5;
  data.users.forEach((user, i) => {
    week.getRow(firstDataRow + i).values = [user.label, user.role || '', ...types.map((t) => user.minutes[t.key])];
  });
  const lastDataRow = firstDataRow + data.users.length - 1;
  const totalRow = week.getRow(lastDataRow + 1);
  totalRow.values = ['Разом', '', ...types.map((t, i) => {
    const col = columnLetter(3 + i);
    const result = data.users.reduce((sum, u) => sum + u.minutes[t.key], 0);
    return { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`, result };
  })];
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });

  // Sheet 2 — per user per day.
  const daily = workbook.addWorksheet('По днях', { views: [{ state: 'frozen', ySplit: 1 }] });
  daily.columns = [{ width: 12 }, { width: 6 }, { width: 34 }, { width: 18 }, ...types.map(() => ({ width: 18 }))];
  daily.getRow(1).values = ['Дата', 'День', 'Користувач', 'Роль', ...typeHeaders];
  styleHeader(daily.getRow(1));
  data.days.forEach((day, i) => {
    const date = moment.utc(day.workDate, 'YYYY-MM-DD');
    const row = daily.getRow(2 + i);
    row.values = [date.toDate(), DAY_NAMES[date.day()], day.label, day.role || '', ...types.map((t) => day.minutes[t.key])];
    row.getCell(1).numFmt = 'dd.mm.yyyy';
  });
  daily.autoFilter = { from: 'A1', to: `${columnLetter(4 + types.length)}1` };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { collect, buildReportData, buildWorkbook };
