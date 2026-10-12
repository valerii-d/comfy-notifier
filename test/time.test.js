const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHHMM, formatHHMM, workWindow, currentWorkWindow, workDate, previousWeek, weekStart, pluralUk, minutesUk
} = require('../src/utils/time');

const KYIV = 'Europe/Kyiv';

test('parseHHMM accepts HH:MM, optional quotes and 24:00', () => {
  assert.equal(parseHHMM('09:30'), 570);
  assert.equal(parseHHMM('9:05'), 545);
  assert.equal(parseHHMM('"18:00"'), 1080);
  assert.equal(parseHHMM('23:59'), 1439);
  assert.equal(parseHHMM('24:00'), 1440);
  assert.equal(parseHHMM('00:00'), 0);
});

test('parseHHMM rejects invalid times', () => {
  for (const bad of ['24:01', '25:00', '12:60', '9:5', 'abc', '', '12-30']) {
    assert.equal(parseHHMM(bad), null, bad);
  }
});

test('formatHHMM pads and round-trips', () => {
  assert.equal(formatHHMM(545), '09:05');
  assert.equal(formatHHMM(1440), '24:00');
  assert.equal(formatHHMM(parseHHMM('17:45')), '17:45');
});

test('currentWorkWindow: inside and outside working hours (Kyiv, UTC+3 in October)', () => {
  const start = parseHHMM('09:00');
  const end = parseHHMM('18:00');
  const inside = new Date('2026-10-12T07:00:00Z'); // 10:00 local
  const before = new Date('2026-10-12T05:30:00Z'); // 08:30 local
  const atEnd = new Date('2026-10-12T15:00:00Z'); // 18:00 local — window is [start, end)

  assert.deepEqual(currentWorkWindow(inside, start, end, KYIV), {
    start: new Date('2026-10-12T06:00:00Z'),
    end: new Date('2026-10-12T15:00:00Z')
  });
  assert.equal(currentWorkWindow(before, start, end, KYIV), null);
  assert.equal(currentWorkWindow(atEnd, start, end, KYIV), null);
});

test('default full-day window ends at the next local midnight', () => {
  const now = new Date('2026-10-12T20:59:00Z'); // 23:59 local
  const window = currentWorkWindow(now, 0, 1440, KYIV);
  assert.deepEqual(window, {
    start: new Date('2026-10-11T21:00:00Z'),
    end: new Date('2026-10-12T21:00:00Z')
  });
});

test('workWindow keeps wall-clock times on a DST change day', () => {
  // Europe/Berlin springs forward 2026-03-29 02:00 -> 03:00: the day is 23 hours.
  const day = new Date('2026-03-29T10:00:00Z');
  const full = workWindow(day, 0, 1440, 'Europe/Berlin');
  assert.equal(full.end - full.start, 23 * 3600 * 1000);

  const office = workWindow(day, parseHHMM('09:00'), parseHHMM('18:00'), 'Europe/Berlin');
  assert.equal(office.start.toISOString(), '2026-03-29T07:00:00.000Z'); // 09:00 CEST (UTC+2)
  assert.equal(office.end.toISOString(), '2026-03-29T16:00:00.000Z');
});

test('workDate uses the local calendar day', () => {
  assert.equal(workDate(new Date('2026-10-11T21:30:00Z'), KYIV), '2026-10-12'); // 00:30 local
  assert.equal(workDate(new Date('2026-10-11T20:30:00Z'), KYIV), '2026-10-11'); // 23:30 local
});

test('previousWeek is the last finished Monday–Sunday week', () => {
  const mondayMidnight = new Date('2026-10-11T21:00:00Z'); // Mon 2026-10-12 00:00 local
  const expected = { start: new Date('2026-10-04T21:00:00Z'), end: new Date('2026-10-11T21:00:00Z') };
  assert.deepEqual(previousWeek(mondayMidnight, KYIV), expected);
  assert.deepEqual(previousWeek(new Date('2026-10-14T12:00:00Z'), KYIV), expected); // Wednesday
  assert.deepEqual(previousWeek(new Date('2026-10-18T20:59:00Z'), KYIV), expected); // Sun 23:59
});

test('weekStart is Monday 00:00 local', () => {
  assert.equal(weekStart(new Date('2026-10-18T20:59:00Z'), KYIV).toISOString(), '2026-10-11T21:00:00.000Z');
});

test('Ukrainian plurals', () => {
  const forms = ['хвилину', 'хвилини', 'хвилин'];
  const cases = { 1: 'хвилину', 2: 'хвилини', 4: 'хвилини', 5: 'хвилин', 10: 'хвилин', 11: 'хвилин',
    12: 'хвилин', 14: 'хвилин', 15: 'хвилин', 21: 'хвилину', 22: 'хвилини', 30: 'хвилин', 111: 'хвилин', 122: 'хвилини' };
  for (const [n, expected] of Object.entries(cases)) assert.equal(pluralUk(Number(n), forms), expected, n);
  assert.equal(minutesUk(10), '10 хвилин');
});
