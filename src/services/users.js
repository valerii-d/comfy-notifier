const { User } = require('../models');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Telegram usernames are case-insensitive.
function usernameQuery(username) {
  return new RegExp(`^${escapeRegex(username.replace(/^@/, ''))}$`, 'i');
}

// Creates or refreshes the user record for a Telegram `from` object.
async function touchUser(from) {
  const fields = {
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null
  };

  let user = await User.findOneAndUpdate({ userId: from.id }, { $set: fields }, { returnDocument: 'after' });
  if (user) return user;

  if (from.username) {
    // Claim a record created by /assign_role before this person used the bot.
    user = await User.findOneAndUpdate(
      { userId: { $exists: false }, username: usernameQuery(from.username) },
      { $set: { userId: from.id, ...fields } },
      { returnDocument: 'after' }
    );
    if (user) return user;
  }

  try {
    return await User.create({ userId: from.id, ...fields });
  } catch (err) {
    if (err.code === 11000) return User.findOne({ userId: from.id }); // concurrent first command
    throw err;
  }
}

// Prefers a record that already has a userId (username may have moved between people).
async function findByUsername(username) {
  const matches = await User.find({ username: usernameQuery(username) });
  return matches.find((u) => u.userId != null) || matches[0] || null;
}

async function assignRole(username, role) {
  const user = await findByUsername(username);
  if (user) {
    user.role = role;
    return user.save();
  }
  return User.create({ username: username.replace(/^@/, ''), role });
}

async function rolesByUserId(userIds) {
  const users = await User.find({ userId: { $in: userIds } });
  return new Map(users.map((u) => [u.userId, u.role]));
}

async function findByUserIds(userIds) {
  const users = await User.find({ userId: { $in: userIds } });
  return new Map(users.map((u) => [u.userId, u]));
}

module.exports = { touchUser, findByUsername, assignRole, rolesByUserId, findByUserIds };
