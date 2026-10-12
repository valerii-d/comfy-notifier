const cron = require('node-cron');
const moment = require('moment-timezone');
const { AbsenceSession, ReportRun } = require('../models');
const report = require('./report');
const admins = require('./admins');
const settings = require('./settings');
const { closeExpired } = require('./reminders');
const { sendMessage } = require('../telegram/send');
const { TIMEZONE } = require('../config');
const { previousWeek, weekStart, formatDate } = require('../utils/time');

// Admin-selected recipients; falls back to DEFAULT_ADMIN_ID admins if none selected.
function recipients() {
  const selected = (settings.get('reportRecipients') || []).filter((id) => admins.isAdmin(id));
  return selected.length > 0 ? selected : admins.bootstrap();
}

// Builds the report for sessions started before `to` (and from `from`, unless
// includeOlder). Returns null when there is nothing to report.
async function buildReport({ from, to, includeOlder = false }) {
  const rows = await report.collect({ from: includeOlder ? null : from, to });
  if (rows.length === 0) return null;

  // Leftovers from a week whose report never went out are included, so widen the label.
  const earliest = rows.reduce((min, r) => (r.workDate < min ? r.workDate : min), rows[0].workDate);
  const earliestStart = moment.tz(earliest, 'YYYY-MM-DD', TIMEZONE).toDate();
  const start = earliestStart < from ? earliestStart : from;
  const lastDay = new Date(to.getTime() - 1);

  const periodStart = formatDate(start, TIMEZONE);
  const periodEnd = formatDate(lastDay, TIMEZONE);
  const buffer = await report.buildWorkbook({ data: report.buildReportData(rows), periodStart, periodEnd });
  const fileDate = (d) => moment.tz(d, TIMEZONE).format('YYYY-MM-DD');
  return {
    buffer,
    filename: `absences_${fileDate(start)}_${fileDate(lastDay)}.xlsx`,
    periodStart,
    periodEnd
  };
}

let running = false;

// Sends last week's report if it hasn't been sent yet, then wipes the reported
// sessions — but only if at least one recipient received it. Safe to call
// repeatedly (Monday cron, hourly retry, startup catch-up).
async function sendWeeklyReport(telegram, { now = new Date(), notifyEmpty = false } = {}) {
  if (running) return { status: 'busy' };
  running = true;
  try {
    const { start, end } = previousWeek(now, TIMEZONE);
    const done = await ReportRun.findOne({ weekStart: start, status: { $in: ['sent', 'empty'] } });
    if (done) return { status: 'already' };

    await closeExpired(telegram, now); // absences still open at the boundary belong to last week

    const to = recipients();
    const built = await buildReport({ from: start, to: end, includeOlder: true });

    if (!built) {
      if (notifyEmpty) {
        const text = `📊 За тиждень ${formatDate(start, TIMEZONE)} – ${formatDate(new Date(end - 1), TIMEZONE)} відсутностей не зафіксовано.`;
        for (const userId of to) await sendMessage(telegram, userId, null, text);
      }
      await ReportRun.updateOne({ weekStart: start }, { $set: { status: 'empty', deliveredTo: [], failed: [] } }, { upsert: true });
      return { status: 'empty' };
    }

    const delivered = [];
    const failed = [];
    for (const userId of to) {
      try {
        await telegram.sendDocument(userId, { source: built.buffer, filename: built.filename }, {
          caption: `📊 Звіт про відсутності за ${built.periodStart} – ${built.periodEnd}`
        });
        delivered.push(userId);
      } catch (err) {
        failed.push({ userId, error: err.description || err.message });
        console.error(`Weekly report: could not send to ${userId}:`, err.description || err.message);
      }
    }

    const status = delivered.length > 0 ? 'sent' : 'failed';
    if (status === 'sent') {
      const { deletedCount } = await AbsenceSession.deleteMany({ startedAt: { $lt: end } });
      console.log(`Weekly report sent to ${delivered.length} recipient(s); wiped ${deletedCount} sessions`);
    } else {
      console.error(`Weekly report not delivered to anyone (${to.length} recipient(s)); data kept, will retry`);
    }
    await ReportRun.updateOne({ weekStart: start }, { $set: { status, deliveredTo: delivered, failed } }, { upsert: true });
    return { status, delivered, failed };
  } finally {
    running = false;
  }
}

// Week-to-date report for one admin (/report_now). Doesn't wipe anything.
async function sendCurrentWeek(telegram, userId, now = new Date()) {
  const built = await buildReport({ from: weekStart(now, TIMEZONE), to: now });
  if (!built) return false;
  await telegram.sendDocument(userId, { source: built.buffer, filename: built.filename }, {
    caption: `📊 Звіт за поточний тиждень: ${built.periodStart} – ${built.periodEnd}`
  });
  return true;
}

function start(telegram) {
  const run = (options) => sendWeeklyReport(telegram, options)
    .catch((err) => console.error('Weekly report failed:', err));

  const weekly = cron.schedule('0 0 * * 1', () => run({ notifyEmpty: true }), { timezone: TIMEZONE });
  const retry = cron.schedule('17 * * * *', () => run(), { timezone: TIMEZONE }); // no-op once sent
  run(); // catch up if the bot was down on Monday 00:00

  return () => {
    weekly.stop();
    retry.stop();
  };
}

module.exports = { start, sendWeeklyReport, sendCurrentWeek, buildReport, recipients };
