# comfy-notifier

A Telegram bot for a team chat: people mark themselves as stepped out, at lunch
or on a short break; the bot shows who is away, reminds them to come back, and
sends admins a weekly Excel report of minutes away. It also posts scheduled
daily announcements.

The bot's interface is in Ukrainian.

## Features

- **Absence tracking** in forum topics — `/out`, `/lunch`, `/break`, `/on_duty`.
  Each announcement includes the current "who is away" list grouped by role.
- **Reminders** until the person returns, with a personal "Я повернувся" button.
  Timings per absence type are set by admins (defaults: out 15/15 min,
  lunch 30/30 min, short break 10/10 min — first reminder / repeat).
- **Working hours** set by admins. Reminders continue until the end of the work
  day; absences still open then are closed automatically. Absence commands are
  refused outside working hours.
- **Weekly Excel report** every Monday 00:00 (bot timezone) to admin-selected
  recipients: minutes away per person per day, grouped by absence type. After
  it's delivered, that week's data is deleted.
- **Scheduled announcements** — daily `HH:MM` messages to a chosen chat/topic.
- Everything is stored in MongoDB and survives restarts.

## Commands

**In group forum topics (everyone)**

| Command | |
|---|---|
| `/out` | Stepped out |
| `/lunch` | At lunch |
| `/break` | Short break |
| `/on_duty` | Back |
| `/my_role` | Show your role (works anywhere) |

**In a private chat with the bot (admins)**

| Command | |
|---|---|
| `/admin_panel` | Buttons for everything below |
| `/add_notification <HH:MM> <text>` | Daily announcement |
| `/delete_notification`, `/clear_notifications` | Remove announcements |
| `/set_notification_target <chat_id> [topic_id]` | Where announcements and reminders go |
| `/notification_target`, `/reset_notification_target` | Show / reset it |
| `/set_command_target <chat_id> [topic_id]` | Where replies to `/out` etc. go |
| `/command_target`, `/clear_command_target` | Show / reset it |
| `/reminders` | Reminder timings |
| `/set_reminder <out\|lunch\|break> <min> [repeat_min]` | Change timings, e.g. `/set_reminder break 10 10` |
| `/workday`, `/set_workday <HH:MM> <HH:MM>` | Working hours, e.g. `/set_workday 09:00 18:00` |
| `/report_recipients` | Choose who receives the weekly report |
| `/report_now` | Week-to-date report to yourself (nothing is deleted) |
| `/add_admin <user_id>`, `/delete_admin` | Manage admins |
| `/add_role <name>`, `/assign_role <@username> <name>` | Roles shown in the status list (also usable in groups) |

Admins listed in `DEFAULT_ADMIN_ID` are permanent; admins added with
`/add_admin` are stored in the database.

> **Report recipients must press Start** in a private chat with the bot once —
> Telegram doesn't let bots message people first. The bot warns when you select
> someone it can't reach. If nobody is selected, the report goes to the
> `DEFAULT_ADMIN_ID` admins.

## Running with Docker

Requirements: Docker with Compose (Docker Desktop on Windows/macOS). MongoDB 8
needs a CPU with AVX (any Intel Core / AMD Ryzen from the last decade).

```bash
cp .env.example .env    # then fill in BOT_TOKEN, DEFAULT_ADMIN_ID, MONGO_ROOT_PASSWORD
docker compose up -d --build
docker compose logs -f bot
```

The stack is two containers: `bot` and `mongo`. MongoDB data lives in the
`mongo-data` volume, so `docker compose down` / `up` keeps it (only
`docker compose down -v` deletes it). Both restart automatically unless
stopped. MongoDB publishes no ports: only the containers of this stack can
reach it, so it doesn't clash with other MongoDB instances on the same machine
(including other Docker projects). Backups and the migration go through
`docker compose exec` / the stack's network.

Only one copy of the bot may run per token. If another instance is still
polling, Telegram rejects the new one with `409 Conflict`.

### Updating

```bash
git pull
docker compose up -d --build
```

### Migrating from MongoDB Atlas (one-off)

1. Put the Atlas connection string into `.env` as `ATLAS_URI`.
2. Stop the old bot.
3. Start MongoDB and copy the data:
   ```bash
   docker compose up -d mongo
   docker compose --profile migrate run --rm migrate
   ```
   This copies roles, users, notifications and chat settings, replacing those
   collections in the local database. Run it before starting the new bot.
4. `docker compose up -d --build`, check that `/admin_panel` → view
   notifications shows your announcements.
5. Remove `ATLAS_URI` from `.env`; delete the Atlas cluster once you're happy.

Trying it first with a **test bot** on the migrated data: the copied chat
targets point at the production chat, which the test bot can't post to, so its
replies and reminders silently fail. In the test bot's private chat, run
`/clear_command_target` and `/reset_notification_target` (this changes only
the local copy), then use it in a test group's topic.

### Backups

```bash
docker compose exec -T mongo sh -c 'mongodump --archive --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' > backup.archive.gz
```

Restore:

```bash
docker compose exec -T mongo sh -c 'mongorestore --archive --gzip --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' < backup.archive.gz
```

## Development

```bash
npm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mongo
npm run dev   # uses MONGODB_URI from .env
```

`docker-compose.dev.yml` publishes MongoDB on `127.0.0.1:27017` so `npm run
dev`, the tests and MongoDB Compass can reach it. If that port is taken, set
`MONGO_HOST_PORT` in `.env` and use the same port in `MONGODB_URI`. Don't use
the dev file on the server.

Use a separate test bot token for development (see the 409 note above).

Tests use Node's built-in runner:

```bash
npm test
```

The integration tests need MongoDB and run only when `MONGODB_TEST_URI` is
set (they use a separate `comfy_notifier_test` database and a fake Telegram
API — no token needed):

```bash
MONGODB_TEST_URI="mongodb://comfy:<password>@127.0.0.1:27017/?authSource=admin" npm test
```

Developer notes (architecture, data model, Telegram quirks): [CLAUDE.md](CLAUDE.md).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | From @BotFather |
| `DEFAULT_ADMIN_ID` | yes | Comma-separated Telegram user IDs of permanent admins |
| `USER_TIMEZONE` | no | Default `Europe/Kyiv`. Working hours, announcements and the weekly report use it |
| `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD` | yes (Docker) | Local MongoDB credentials. Any characters; wrap in single quotes if the password contains `$`. Only applied when the database volume is first created |
| `MONGODB_DB_NAME` | no | Default `comfy_notifier` |
| `MONGODB_URI` | outside Docker | Compose sets it automatically. Without credentials, `MONGO_ROOT_*` are used |
| `ATLAS_URI` | migration only | Source for the one-off Atlas migration |

## License

MIT
