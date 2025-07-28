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
    console.log("get-player-mission: Function started."); // LOG 1
    if (event.httpMethod !== 'GET') {
        console.log("get-player-mission: Method Not Allowed."); // LOG 2
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-mission: Google Sheet ID is not configured."); // LOG 3
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`get-player-mission: Sheet ID: ${sheetId}`); // LOG 4

    const playerId = event.queryStringParameters.playerId;
    if (!playerId) {
        console.log("get-player-mission: Missing playerId query parameter."); // LOG 5
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId.' }) };
    }
    console.log(`get-player-mission: Fetching mission for player: ${playerId}`); // LOG 6

    try {
        const sheets = await getSheetsService();
        console.log("get-player-mission: Sheets service initialized."); // LOG 7

        const missionsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Missions!A:D', // Assuming MissionID, MissionDescription, PlayerID, IsActive are in A:D
        });

        const allMissions = missionsResponse.data.values || [];
        console.log("get-player-mission: Raw data fetched from Missions sheet:", JSON.stringify(allMissions)); // LOG 8

        if (allMissions.length < 2) {
            console.log("get-player-mission: Missions sheet is empty or has no data rows."); // LOG 9
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No missions data available.', currentMission: null }),
            };
        }

        const headers = allMissions[0];
        const missionRows = allMissions.slice(1);
        console.log("get-player-mission: Mission Headers:", headers); // LOG 10
        console.log(`get-player-mission: Processing ${missionRows.length} mission data rows.`); // LOG 11

        const missionIdCol = headers.indexOf('MissionID');
        const descriptionCol = headers.indexOf('MissionDescription');
        const playerIdCol = headers.indexOf('PlayerID'); // Column C, index 2
        const isActiveCol = headers.indexOf('IsActive'); // Column D, index 3

        console.log(`get-player-mission: Column indices: MissionID=${missionIdCol}, Description=${descriptionCol}, PlayerID=${playerIdCol}, IsActive=${isActiveCol}`); // LOG 12

        if ([missionIdCol, descriptionCol, playerIdCol, isActiveCol].includes(-1)) {
            console.error("get-player-mission: One or more required columns not found in Missions sheet (MissionID, MissionDescription, PlayerID, IsActive)."); // LOG 13
            throw new Error("Required columns not found in Missions sheet.");
        }

        let currentMissionData = null;
        for (const row of missionRows) {
            const rowPlayerId = row[playerIdCol] ? String(row[playerIdCol]).trim() : ''; // Ensure string and trim
            const rowIsActive = row[isActiveCol] ? String(row[isActiveCol]).toUpperCase().trim() : 'FALSE'; // Ensure string, uppercase, trim

            console.log(`get-player-mission: Checking row for PlayerID '${rowPlayerId}' (expected '${playerId}'), IsActive: '${rowIsActive}'`); // LOG 14

            // Find the mission for the specific player that is active
            if (rowPlayerId === playerId && rowIsActive === 'TRUE') {
                currentMissionData = {
                    MissionID: row[missionIdCol],
                    MissionDescription: row[descriptionCol],
                    PlayerID: row[playerIdCol],
                    IsActive: row[isActiveCol]
                };
                console.log("get-player-mission: Found active mission:", currentMissionData); // LOG 15
                break; // Assuming one active mission per player
            }
        }
        console.log(`get-player-mission: Final mission found for ${playerId}:`, currentMissionData ? currentMissionData.MissionDescription : 'None'); // LOG 16

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Player mission fetched successfully.', currentMission: currentMissionData }),
        };

    } catch (error) {
        console.error('get-player-mission: Error in handler:', error); // LOG 17
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player mission.', details: error.message }),
        };
    } finally {
        console.log("get-player-mission: Function finished."); // LOG 18
    }
};