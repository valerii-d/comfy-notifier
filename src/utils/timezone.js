function getServerTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      console.log(`Server timezone detected: ${tz}`);
      return tz;
    }
    throw new Error('Could not detect timezone');
  } catch (error) {
    console.error('Error detecting server timezone:', error);
    return 'UTC'; // Fallback to UTC
  }
}

module.exports = { getServerTimezone };
