// netlify/functions/complete-mission.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { playerId, missionId, adminId } = JSON.parse(event.body);
        if (!playerId || !missionId || !adminId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId, missionId, or adminId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Fetch Missions and Players data
        const [missionsResponse, playersResponse] = await Promise.all([
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Missions!A:D' }),
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Players!A:W' }) // Read up to new columns
        ]);

        const missionHeaders = missionsResponse.data.values[0];
        const missions = missionsResponse.data.values.slice(1);
        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        // 2. Find the mission to determine the ability to unlock
        const missionIdCol = missionHeaders.indexOf('MissionID');
        const abilityUnlockedCol = missionHeaders.indexOf('AbilityUnlocked');
        
        const mission = missions.find(m => m[missionIdCol] === missionId);
        if (!mission) {
            return { statusCode: 404, body: JSON.stringify({ error: `Mission with ID ${missionId} not found.` }) };
        }
        const abilityToUnlock = mission[abilityUnlockedCol];

        // 3. Find the player and the column for the ability to unlock
        const playerIdCol = playerHeaders.indexOf('PlayerID');
        const missionsCompletedCol = playerHeaders.indexOf('MissionsCompleted');
        const abilityColumnIndex = playerHeaders.indexOf(abilityToUnlock);

        if (abilityColumnIndex === -1) {
            return { statusCode: 500, body: JSON.stringify({ error: `Ability column '${abilityToUnlock}' not found in Players sheet.` }) };
        }

        const playerRowIndex = players.findIndex(p => p[playerIdCol] === playerId) + 2; // +2 for 1-based index and header
        if (playerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: `Player with ID ${playerId} not found.` }) };
        }

        // 4. Prepare the batch update request
        const currentMissionsCompleted = parseInt(players[playerRowIndex - 2][missionsCompletedCol] || 0);
        
        const requests = [
            { // Update the ability flag to TRUE
                range: `Players!${String.fromCharCode(65 + abilityColumnIndex)}${playerRowIndex}`,
                values: [['TRUE']]
            },
            { // Increment the mission completion count
                range: `Players!${String.fromCharCode(65 + missionsCompletedCol)}${playerRowIndex}`,
                values: [[currentMissionsCompleted + 1]]
            }
        ];

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        });

        console.log(`Admin ${adminId} marked mission ${missionId} as complete for player ${playerId}, unlocking ability ${abilityToUnlock}.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Mission completed for player. Ability '${abilityToUnlock}' unlocked.` }),
        };

    } catch (error) {
        console.error('Error in complete-mission function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to complete mission.', details: error.message }),
        };
    }
};
