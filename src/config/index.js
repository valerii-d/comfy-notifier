// Values read from the environment once, at startup (dotenv is loaded first in index.js).

function parseIds(value) {
  return (value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
    .filter((id) => {
      if (Number.isInteger(id)) return true;
      console.warn(`Invalid admin ID in DEFAULT_ADMIN_ID: ${id}`);
      return false;
    });
}

module.exports = {
  TIMEZONE: process.env.USER_TIMEZONE || 'Europe/Kyiv',
  BOOTSTRAP_ADMIN_IDS: parseIds(process.env.DEFAULT_ADMIN_ID)
};
