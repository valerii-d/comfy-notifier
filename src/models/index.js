const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }
});

// Keyed by Telegram userId. A record created by /assign_role before the person
// has used the bot has only a username; it is claimed on their first command.
// Never set userId to null: the sparse unique index would treat nulls as duplicates.
const userSchema = new mongoose.Schema({
  userId: { type: Number, sparse: true, unique: true },
  username: { type: String, default: null, index: true },
  firstName: { type: String, default: null },
  lastName: { type: String, default: null },
  role: { type: String, default: null }
});

const notificationSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  cronTime: { type: String, required: true },
  originalTime: { type: String, required: true },
  message: { type: String, required: true },
  chatId: { type: Number, required: true },
  topicId: { type: Number, default: null }
});

const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null }
});

// Admins added through the bot. Admins from DEFAULT_ADMIN_ID are not stored here.
const adminSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  addedBy: { type: Number, default: null },
  addedAt: { type: Date, default: Date.now }
});

// Admin-editable reminder timings. Labels and texts live in src/services/absenceTypes.js.
const absenceTypeSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  firstReminderMin: { type: Number, required: true, min: 1 },
  repeatReminderMin: { type: Number, required: true, min: 1 }
});

// Who is away right now — one document per user.
const activeAbsenceSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  type: { type: String, required: true },
  username: { type: String, default: null },
  displayName: { type: String, default: null },
  startedAt: { type: Date, required: true },
  // End of the work day the absence started in: reminders stop and it is auto-closed then.
  closeAt: { type: Date, required: true, index: true },
  nextReminderAt: { type: Date, default: null, index: true },
  remindersSent: { type: Number, default: 0 },
  pingChatId: { type: Number, required: true },
  pingTopicId: { type: Number, default: null },
  replyChatId: { type: Number, required: true },
  replyTopicId: { type: Number, default: null }
});

// One finished absence — the raw data for the weekly report. Wiped after the report is sent.
const absenceSessionSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  username: { type: String, default: null },
  displayName: { type: String, default: null },
  type: { type: String, required: true },
  startedAt: { type: Date, required: true, index: true },
  endedAt: { type: Date, required: true },
  durationMs: { type: Number, required: true },
  workDate: { type: String, required: true }, // YYYY-MM-DD in USER_TIMEZONE
  endedBy: { type: String, enum: ['command', 'button', 'switch', 'auto'], required: true }
});

const reportRunSchema = new mongoose.Schema({
  weekStart: { type: Date, required: true, unique: true },
  status: { type: String, enum: ['sent', 'empty', 'failed'], required: true },
  deliveredTo: { type: [Number], default: [] },
  failed: { type: [{ userId: Number, error: String }], default: [] }
}, { timestamps: true });

const Role = mongoose.model('Role', roleSchema);
const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Config = mongoose.model('Config', configSchema);
const Admin = mongoose.model('Admin', adminSchema, 'admins');
const AbsenceType = mongoose.model('AbsenceType', absenceTypeSchema, 'absence_types');
const ActiveAbsence = mongoose.model('ActiveAbsence', activeAbsenceSchema, 'active_absences');
const AbsenceSession = mongoose.model('AbsenceSession', absenceSessionSchema, 'absence_sessions');
const ReportRun = mongoose.model('ReportRun', reportRunSchema, 'report_runs');

module.exports = {
  Role, User, Notification, Config, Admin,
  AbsenceType, ActiveAbsence, AbsenceSession, ReportRun
};
