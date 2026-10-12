const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildReportData, buildWorkbook } = require('../src/services/report');

const MIN = 60 * 1000;

const rows = [
  { userId: 1, username: 'alice', displayName: 'Alice A', role: 'Dev', workDate: '2026-10-05', type: 'out', durationMs: 20.4 * MIN },
  { userId: 1, username: 'alice', displayName: 'Alice A', role: 'Dev', workDate: '2026-10-05', type: 'break', durationMs: 9.6 * MIN },
  { userId: 1, username: 'alice', displayName: 'Alice A', role: 'Dev', workDate: '2026-10-06', type: 'out', durationMs: 10.4 * MIN },
  { userId: 2, username: null, displayName: 'Bob', role: null, workDate: '2026-10-05', type: 'lunch', durationMs: 45 * MIN },
  { userId: 2, username: null, displayName: 'Bob', role: null, workDate: '2026-10-05', type: 'removed_type', durationMs: 99 * MIN }
];

test('buildReportData: minutes per user per day per type, weekly totals agree with days', () => {
  const data = buildReportData(rows);

  assert.deepEqual(data.days.map((d) => [d.workDate, d.label, d.minutes]), [
    ['2026-10-05', 'Alice A (@alice)', { out: 20, lunch: 0, break: 10 }],
    ['2026-10-05', 'Bob', { out: 0, lunch: 45, break: 0 }],
    ['2026-10-06', 'Alice A (@alice)', { out: 10, lunch: 0, break: 0 }]
  ]);

  // 20 + 10 (rounded daily values), not round(20.4 + 10.4) = 31
  assert.deepEqual(data.users.map((u) => [u.label, u.role, u.minutes]), [
    ['Alice A (@alice)', 'Dev', { out: 30, lunch: 0, break: 10 }],
    ['Bob', null, { out: 0, lunch: 45, break: 0 }]
  ]);
});

test('buildWorkbook: two sheets with headers, values and totals', async () => {
  const buffer = await buildWorkbook({
    data: buildReportData(rows),
    periodStart: '05.10.2026',
    periodEnd: '11.10.2026'
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ['Тиждень', 'По днях']);

  const week = workbook.getWorksheet('Тиждень');
  assert.equal(week.getCell('A2').value, 'Період: 05.10.2026 – 11.10.2026');
  assert.deepEqual(week.getRow(4).values.slice(1), ['Користувач', 'Роль', 'Вийшов, хв', 'Обід, хв', 'Коротка перерва, хв']);
  assert.deepEqual(week.getRow(5).values.slice(1), ['Alice A (@alice)', 'Dev', 30, 0, 10]);
  assert.deepEqual(week.getRow(6).values.slice(1), ['Bob', '', 0, 45, 0]);
  assert.equal(week.getCell('A7').value, 'Разом');
  assert.deepEqual(week.getCell('D7').value, { formula: 'SUM(D5:D6)', result: 45 });

  const daily = workbook.getWorksheet('По днях');
  assert.deepEqual(daily.getRow(1).values.slice(1), ['Дата', 'День', 'Користувач', 'Роль', 'Вийшов, хв', 'Обід, хв', 'Коротка перерва, хв']);
  const first = daily.getRow(2).values.slice(1);
  assert.equal(first[0].toISOString().slice(0, 10), '2026-10-05');
  assert.deepEqual(first.slice(1), ['Пн', 'Alice A (@alice)', 'Dev', 20, 0, 10]);
  assert.equal(daily.getCell('A2').numFmt, 'dd.mm.yyyy');
  assert.equal(daily.rowCount, 4);
});
