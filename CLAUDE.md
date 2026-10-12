# comfy-notifier — developer notes

Internal notes for whoever (human or Claude) works on this bot. User/admin
guide and Docker runbook: `README.md`. Keep this file current when behaviour
changes.

## What it is

A Telegram bot for a Ukrainian-speaking team chat:

1. **Absence tracking.** `/out`, `/lunch`, `/break` (short break) and
   `/on_duty` in a forum topic. The bot announces it with a "who is away" list
   grouped by type and role, reminds the person until they return, and closes
   forgotten absences at the end of the admin-defined work day.
2. **Weekly Excel report** (Monday 00:00) of minutes away per person per day
   per absence type, sent to admin-selected recipients; reported data is
   then deleted.
3. **Scheduled announcements** — daily `HH:MM` messages.

## Stack & commands

- Node.js ≥ 20.19 (CommonJS, no build step). Docker image: `node:24-alpine`.
- `telegraf@4.16` (long polling), `mongoose@9`, `node-cron@3`,
  `moment-timezone`, `exceljs@4.4.0` (pinned; only used to *write* files).
- Runs as a Docker Compose stack: `bot` + `mongo:8.0` (volume `mongo-data`).
  `mongo` publishes **no host ports** (the server already runs another
  project's MongoDB on 27017); the bot reaches it as `mongo:27017`.
  `docker-compose.dev.yml` publishes it on 127.0.0.1 for local dev/tests.
- `npm start` / `npm run dev` (needs `MONGODB_URI`), `npm test`.
- Integration tests run only with `MONGODB_TEST_URI` set (see README).

**Only one process may poll a bot token** — a second one gets
`409 Conflict`. Use a separate dev bot token locally.

`bot.launch()` in Telegraf 4.16 resolves only when polling stops — put
"started" logic in its `onLaunch` callback, not after `await`.

## File map

```
index.js                     startup: connect DB, sync indexes, load services, start jobs, launch
src/bot.js                   createBot(token) registers handlers; setCommands() (autocomplete)
src/config/index.js          TIMEZONE, BOOTSTRAP_ADMIN_IDS (from env, read once)
src/config/db.js             mongoose.connect with retries
src/models/index.js          all schemas
src/handlers/user.js         /start /help /out /lunch /break /on_duty /my_role, back:<id> button
src/handlers/admin.js        admin commands, admin panel buttons, recipients toggles
src/services/settings.js     key/value `configs` with in-memory cache (targets, work day, recipients)
src/services/admins.js       bootstrap (env) + persisted admins
src/services/absenceTypes.js TYPES (texts, emoji, commands) + timings from MongoDB
src/services/absences.js     startAbsence / endAbsence — the absence state machine
src/services/reminders.js    30 s ticker: auto-close at end of day, send due reminders
src/services/notifications.js daily announcements (keeps cron task handles)
src/services/report.js       aggregation + pure shaping + xlsx building
src/services/weeklyReport.js Monday cron, hourly retry, startup catch-up, wipe, /report_now
src/services/users.js        user records keyed by userId, role lookups
src/telegram/send.js         sendMessage with topic → General fallback (never throws)
src/telegram/format.js       escapeHtml, mention (tg://user link if no username), labels
src/telegram/status.js       "who is away" block
src/utils/time.js            pure time maths: HH:MM, work-day window, weeks, Ukrainian plurals
test/                        node:test — unit (time, report) + integration (Mongo + fake Telegram)
```

## Data model (MongoDB)

Everything that matters is persisted; in-memory caches (settings, admins,
timings, notification tasks) are rebuilt at startup.

| Collection | Contents |
|---|---|
| `configs` | `{key, value}`: `defaultNotificationChat/Topic`, `defaultCommandChat/Topic`, `workDayStart/End` (minutes after midnight, default 0/1440), `reportRecipients` ([userId]) |
| `admins` | admins added via `/add_admin`. `DEFAULT_ADMIN_ID` admins are not stored and can't be removed in the bot |
| `users` | `{userId (unique sparse), username, firstName, lastName, role}`. Docs created by `/assign_role` have no userId until that person's first command claims them. **Never set userId to null** (sparse unique index) |
| `roles` | `{name}` |
| `notifications` | `{id, cronTime, originalTime, message, chatId, topicId}` |
| `absence_types` | `{key, firstReminderMin, repeatReminderMin}` — seeded for out/lunch/break, admin-editable |
| `active_absences` | one per away user: `{userId (unique), type, startedAt, closeAt, nextReminderAt, remindersSent, ping/replyChatId+TopicId, username, displayName}` |
| `absence_sessions` | finished absences: `{userId, type, startedAt, endedAt, durationMs, workDate 'YYYY-MM-DD', endedBy: command/button/switch/auto}` — wiped after each weekly report |
| `report_runs` | `{weekStart (unique), status: sent/empty/failed, deliveredTo, failed}` — makes the weekly job idempotent |

Startup runs `syncIndexes()` on all models — this is what dropped the old
unique `username` index from the Atlas data. Adding/changing an index in a
schema is applied automatically; removing one drops it. Mongoose `autoIndex`
is **off** (`src/config/db.js`, and in the integration test): with it on, its
background index build races `syncIndexes()` and fails with
`IndexKeySpecsConflict` on migrated data.

## Flows

### Absence lifecycle

1. `/out|/lunch|/break` must come from a forum topic (`is_topic_message`).
2. Outside working hours → refused.
3. Same type already active → "already marked since HH:MM". Different type →
   current one closed (`endedBy: 'switch'`) and the new one started.
4. `closeAt` = end of that day's work window; `nextReminderAt` = start +
   first-reminder minutes.
5. Ticker (every 30 s): first closes absences with `closeAt <= now`
   (session `endedAt = closeAt`, one 🌙 notice per chat), then sends due
   reminders. A reminder is claimed with a conditional update on
   `nextReminderAt` before sending, so it can't be sent twice.
6. `/on_duty`, the `back:<userId>` button (only that user or an admin), the
   switch or the auto-close all go through `endAbsence`, which uses
   `findOneAndDelete` → each absence is recorded exactly once.

Changing working hours recomputes `closeAt` for running absences.
Changing timings applies to new absences, and to running ones from their next
reminder.

### Message routing

- **Command target** (`/set_command_target`): replies to absence commands and
  the 🌙 auto-close notice. Unset → the topic the command came from.
- **Notification target** (`/set_notification_target`): announcements and
  reminder pings. Unset → the topic the command came from.
- All sends go through `telegram/send.js` (topic first, then General).
  Absence messages use `parse_mode: 'HTML'` — escape user-provided text.

### Weekly report

- Cron `0 0 * * 1` in `USER_TIMEZONE` → `sendWeeklyReport`; also hourly
  (`17 * * * *`) and at startup — all no-ops once `report_runs` has the week.
- It first runs the auto-close pass, then reports **all** sessions started
  before the week's end (so leftovers from a missed week aren't lost).
- Delivered to ≥ 1 recipient → sessions `startedAt < weekEnd` deleted,
  status `sent`. Nobody reached → `failed`, data kept, retried hourly.
- Empty week: recipients get a short "no absences" message only from the
  Monday run (not from catch-up).
- Recipients = `reportRecipients` ∩ current admins; empty → bootstrap admins.
- Report content: **minutes only** per absence type — no counts. Sheets: "Тиждень" (per user totals + SUM row), "По днях" (per user
  per day, auto-filter). Daily minutes are rounded first, weekly totals sum
  the rounded values so the sheets agree.

## Product decisions (agreed with the owner, Oct 2026)

- Deployment: Docker Compose (`bot` + `mongo`) on an Intel i5-10400 PC;
  MongoDB Atlas was migrated away from (data copied with the `migrate` service).
- Report: per user per day, **total minutes grouped by absence type** — the
  owner explicitly doesn't want absence counts. Sent Monday 00:00; data is
  wiped once delivered to at least one recipient.
- Reminders continue **until the end of the work day**, then the absence is
  auto-closed. Work-day start/end are set by admins (default 00:00–24:00,
  same-day only — overnight shifts aren't supported).
- Absence commands are refused outside working hours.
- The toilet break is deliberately called **"Коротка перерва"** (`/break`, ☕)
  — keep the neutral wording.
- Only reminder timings are admin-editable; the set of absence types is fixed
  in code (`src/services/absenceTypes.js`).

## Telegram platform gotchas

- Bots can't start a private chat: a user must press Start first, otherwise
  403. `sendChatAction` is used as a cheap probe when selecting recipients.
- Inline buttons in groups can be pressed by anyone — check `ctx.from.id`.
- `callback_data` ≤ 64 bytes. Notification deletion uses the id
  (`delete_notif:<id>`), never an array index.
- `ctx.reply` in Telegraf 4.16 automatically stays in the same forum topic.
- General topic / non-forum groups: `is_topic_message` is falsy.
- `@username` mentions only work for users with a username; otherwise use
  `<a href="tg://user?id=…">`.

## Conventions

- UI strings are **Ukrainian**; code, logs and comments are English.
- Handlers never throw to the user: log with `console.error`, reply with a
  short Ukrainian error.
- Secrets live in `.env` (gitignored, see `.env.example`). The repo is
  **public** — never commit `.env`, `.env.*` backups or key files.
- Add tests for pure logic in `test/*.test.js`; for handler flows extend
  `test/integration.test.js` (fake Telegram via `Telegram.prototype.callApi`).

## Open items

- The Google service-account key committed in 04f4b07 must be deleted in
  Google Cloud Console (it's still in git history; the file is untracked now).
- After the production cut-over: take a final dump of the Atlas cluster, then
  delete it (its `test` database isn't from this project — check nothing else
  uses the cluster), remove `ATLAS_URI` from `.env`, delete `.env.atlas.bak`.
- `uuid@8` (via exceljs/node-cron) has a moderate advisory that doesn't apply
  to the v4 API used here; `npm audit` will keep listing it.
