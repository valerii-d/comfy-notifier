const moment = require('moment-timezone');
const { User } = require('../models');

async function getStatusMessage(state) {
  const usersOut = Array.from(state.usersOut.entries());
  const usersLunch = Array.from(state.usersLunch.entries());

  if (usersOut.length === 0 && usersLunch.length === 0) {
    return '';
  }

  const allUserIds = [...new Set([...usersOut.map(([id]) => id), ...usersLunch.map(([id]) => id)])];
  const dbUsers = await User.find({ userId: { $in: allUserIds } });
  const userMap = new Map(dbUsers.map(u => [u.userId, u]));

  let statusMsg = '\n\n📊 Поточний статус:';

  const groupByRole = (entries) => {
    const roles = new Map(); // roleName -> [username]
    for (const [userId, data] of entries) {
      const dbUser = userMap.get(userId);
      const role = dbUser && dbUser.role ? dbUser.role : 'Без ролі';
      if (!roles.has(role)) roles.set(role, []);
      roles.get(role).push(`@${data.username}`);
    }
    return roles;
  };

  if (usersOut.length > 0) {
    statusMsg += '\n🚶 Відсутні:';
    const outByRole = groupByRole(usersOut);
    for (const [role, users] of outByRole) {
      statusMsg += `\n  🔹 ${role}: ${users.join(', ')}`;
    }
  }

  if (usersLunch.length > 0) {
    statusMsg += '\n🍽️ На обіді:';
    const lunchByRole = groupByRole(usersLunch);
    for (const [role, users] of lunchByRole) {
      statusMsg += `\n  🔹 ${role}: ${users.join(', ')}`;
    }
  }

  return statusMsg;
}

module.exports = { getStatusMessage };
