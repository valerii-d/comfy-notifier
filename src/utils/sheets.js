const moment = require('moment-timezone');
const sheets = require('../config/sheets');

async function saveTimeTrackingToGoogleSheets(state, userTimezone) {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      console.log('Google Spreadsheet ID not configured, skipping data save');
      return;
    }

    const today = moment().tz(userTimezone);
    const monthYear = today.format('YYYY-MM'); // e.g., "2024-01"
    const sheetName = `Sheet_${monthYear}`;
    const rows = [];

    // Prepare data for current users
    for (const [username, tracking] of state.userTimeTracking) {
      const outHours = Math.round((tracking.totalOutTime / (1000 * 60 * 60)) * 100) / 100;
      const lunchHours = Math.round((tracking.totalLunchTime / (1000 * 60 * 60)) * 100) / 100;
      
      rows.push([
        today.format('YYYY-MM-DD'),
        username,
        outHours,
        lunchHours
      ]);
    }

    if (rows.length > 0) {
      try {
        // Try to append to existing sheet
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:D`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: rows
          }
        });
      } catch (error) {
        if (error.code === 400 && error.message.includes('Unable to parse range')) {
          // Sheet doesn't exist, create it first
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: sheetName
                    }
                  }
                }
              ]
            }
          });

          // Add headers to the new sheet
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1:D1`,
            valueInputOption: 'RAW',
            resource: {
              values: [['Дата', 'Користувач', 'Години відсутності', 'Години обіду']]
            }
          });

          // Now append the data
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:D`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: {
              values: rows
            }
          });
        } else {
          throw error;
        }
      }
      
      console.log(`Saved time tracking data for ${rows.length} users to Google Sheets (${sheetName})`);
      
      // Clear the tracking data after saving
      state.userTimeTracking.clear();
    }
  } catch (error) {
    console.error('Error saving to Google Sheets:', error);
  }
}

module.exports = { saveTimeTrackingToGoogleSheets };
