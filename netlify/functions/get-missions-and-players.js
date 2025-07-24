// netlify/functions/get-missions-and-players.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const [playersResponse, missionsResponse] = await Promise.all([
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Players!A:W' }),
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Missions!A:D' })
        ]);

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);
        const missionHeaders = missionsResponse.data.values[0];
        const missions = missionsResponse.data.values.slice(1);

        const missionMap = new Map(missions.map(m => [m[missionHeaders.indexOf('MissionID')], m]));

        const idCol = playerHeaders.indexOf('PlayerID');
        const nameCol = playerHeaders.indexOf('Name');
        const missionIdCol = playerHeaders.indexOf('CurrentMissionID');

        const result = players.map(player => {
            const currentMissionId = player[missionIdCol];
            const mission = missionMap.get(currentMissionId);
            return {
                playerId: player[idCol],
                playerName: player[nameCol],
                missionId: currentMissionId,
                missionDescription: mission ? mission[missionHeaders.indexOf('MissionDescription')] : 'No Active Mission'
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error('Error in get-missions-and-players function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch mission data.', details: error.message }),
        };
    }
};
