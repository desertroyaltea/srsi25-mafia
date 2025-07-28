// netlify/functions/update-player-welcome-status.js

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
    console.log("update-player-welcome-status: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("update-player-welcome-status: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("update-player-welcome-status: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let playerId;
    try {
        const body = JSON.parse(event.body);
        playerId = body.playerId;
    } catch (e) {
        console.error("update-player-welcome-status: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    if (!playerId) {
        console.log("update-player-welcome-status: Missing playerId in request body.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId.' }) };
    }
    console.log(`update-player-welcome-status: Updating Welcome status for player: ${playerId}`);

    try {
        const sheets = await getSheetsService();

        // 1. Fetch player data to find the row and Welcome column
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'Welcome' is found
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("update-player-welcome-status: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const welcomeCol = 26; // NEW column index

// Ensure PlayerID column is found (Welcome is now hardcoded)
        if (idCol === -1) {
            console.error("update-player-welcome-status: Required column 'PlayerID' not found in Players sheet.");
            throw new Error("Required column 'PlayerID' not found in Players sheet.");
        }
        // welcomeCol is now hardcoded to 26, so no need to check its indexOf result here.

        let playerRowIndex = -1;
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === playerId) {
                playerRowIndex = i + 2; // +2 for 0-index and header row
                break;
            }
        }
        console.log(`update-player-welcome-status: Player ${playerId} found at row ${playerRowIndex}.`);

        if (playerRowIndex === -1) {
            console.log("update-player-welcome-status: Player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }

        // 2. Update the player's Welcome status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + welcomeCol)}${playerRowIndex}`;
        console.log(`update-player-welcome-status: Updating Welcome status for ${playerId} at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });
        console.log(`update-player-welcome-status: Player ${playerId}'s Welcome status updated to TRUE.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Welcome status updated successfully!' }),
        };

    } catch (error) {
        console.error('update-player-welcome-status: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update welcome status.', details: error.message }),
        };
    } finally {
        console.log("update-player-welcome-status: Function finished.");
    }
};