const absenceTypes = require('../services/absenceTypes');
const { listActive } = require('../services/absences');
const { rolesByUserId } = require('../services/users');
const { mention, escapeHtml } = require('./format');

// "Who is away" block appended to /out, /lunch, /break, /on_duty replies (HTML).
async function getStatusMessage() {
  const active = await listActive();
  if (active.length === 0) return '';

  const roles = await rolesByUserId(active.map((a) => a.userId));
  let message = '\n\n📊 Поточний статус:';

  for (const type of absenceTypes.TYPES) {
    const ofType = active.filter((a) => a.type === type.key);
    if (ofType.length === 0) continue;

    const byRole = new Map(); // role -> [mention]
    for (const absence of ofType) {
      const role = roles.get(absence.userId) || 'Без ролі';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(mention(absence));
    }

    message += `\n${type.emoji} ${type.listTitle}:`;
    for (const [role, people] of byRole) {
      message += `\n  🔹 ${escapeHtml(role)}: ${people.join(', ')}`;
    }
  }
  return message;
}

module.exports = { getStatusMessage };
