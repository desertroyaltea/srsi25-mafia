// netlify/functions/get-player-mission.js

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
    console.log("get-player-mission: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-player-mission: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-mission: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const playerId = event.queryStringParameters.playerId;
    if (!playerId) {
        console.log("get-player-mission: Missing playerId query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId.' }) };
    }
    console.log(`get-player-mission: Fetching mission for player: ${playerId}`);

    try {
        const sheets = await getSheetsService();

        const missionsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Missions!A:D', // Assuming MissionID, MissionDescription, PlayerID, IsActive are in A:D
        });

        const allMissions = missionsResponse.data.values || [];
        if (allMissions.length < 2) {
            console.log("get-player-mission: Missions sheet is empty or has no data rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No missions data available.', currentMission: null }),
            };
        }

        const headers = allMissions[0];
        const missionRows = allMissions.slice(1);

        const missionIdCol = headers.indexOf('MissionID');
        const descriptionCol = headers.indexOf('MissionDescription');
        const playerIdCol = headers.indexOf('PlayerID');
        const isActiveCol = headers.indexOf('IsActive');

        if ([missionIdCol, descriptionCol, playerIdCol, isActiveCol].includes(-1)) {
            console.error("get-player-mission: One or more required columns not found in Missions sheet (MissionID, MissionDescription, PlayerID, IsActive).");
            throw new Error("Required columns not found in Missions sheet.");
        }

        let currentMissionData = null;
        for (const row of missionRows) {
            // Find the mission for the specific player that is active
            if (row[playerIdCol] === playerId && row[isActiveCol] === 'TRUE') {
                currentMissionData = {
                    MissionID: row[missionIdCol],
                    MissionDescription: row[descriptionCol],
                    PlayerID: row[playerIdCol],
                    IsActive: row[isActiveCol]
                };
                break; // Assuming one active mission per player
            }
        }
        console.log(`get-player-mission: Mission found for ${playerId}:`, currentMissionData ? currentMissionData.MissionDescription : 'None');

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Player mission fetched successfully.', currentMission: currentMissionData }),
        };

    } catch (error) {
        console.error('get-player-mission: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player mission.', details: error.message }),
        };
    }
};