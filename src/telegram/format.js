// Helpers for messages sent with parse_mode: 'HTML'.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function displayName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

// Snapshot of who did something, stored on absences/sessions.
function personFrom(from) {
  return { userId: from.id, username: from.username || null, displayName: displayName(from) };
}

// @username when there is one; otherwise a tg://user link so people without a
// username are still notified.
function mention({ userId, username, displayName: name }) {
  if (username) return `@${username}`;
  return `<a href="tg://user?id=${userId}">${escapeHtml(name || userId)}</a>`;
}

// Plain-text label for admin lists and the Excel report.
function label({ userId, username, displayName: name }) {
  if (name && username) return `${name} (@${username})`;
  if (username) return `@${username}`;
  return name || String(userId);
}

module.exports = { escapeHtml, displayName, personFrom, mention, label };
