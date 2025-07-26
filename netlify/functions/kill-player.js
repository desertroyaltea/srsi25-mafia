// netlify/functions/kill-player.js

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
    console.log("kill-player: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("kill-player: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("kill-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`kill-player: Sheet ID: ${sheetId}`);

    try {
        const { mafiaPlayerId, targetPlayerId1, targetPlayerId2 } = JSON.parse(event.body);
        console.log(`kill-player: Received - Mafia: ${mafiaPlayerId}, Target 1: ${targetPlayerId1}, Target 2: ${targetPlayerId2}`);
        if (!mafiaPlayerId || !targetPlayerId1 || !targetPlayerId2) {
            console.log("kill-player: Missing mafiaPlayerId or one of the targetPlayerIds.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId or targetPlayerIds.' }) };
        }

        const sheets = await getSheetsService();
        console.log("kill-player: Sheets service initialized.");

        // 1. Fetch all player data to check action usage and update MainUsed
        console.log("kill-player: Fetching Players sheet for action usage check.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'MainUsed' and 'Role' are found
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("kill-player: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1); // Actual player data rows

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role'); // Needed for other checks
        const mainUsedCol = 20; // Explicitly set to column U (0-indexed) as requested

        console.log(`kill-player: PlayerID index: ${idCol}, Role index: ${roleCol}, MainUsed index (hardcoded): ${mainUsedCol}`);

        // Ensure critical dynamic columns are found
        if (idCol === -1 || roleCol === -1) {
            console.error("kill-player: Required columns 'PlayerID' or 'Role' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'Role' not found in Players sheet.");
        }
        // No need to check mainUsedCol here as it's hardcoded.

        // Find the Mafia player's row index and check their MainUsed status
        let mafiaPlayerRowIndex = -1;
        let mafiaMainUsedStatus = 'FALSE';
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === mafiaPlayerId) {
                mafiaPlayerRowIndex = i + 2; // +2 for 0-index and header row
                // Ensure mainUsedCol is within bounds of the fetched row
                if (mainUsedCol < playerRows[i].length) {
                    mafiaMainUsedStatus = playerRows[i][mainUsedCol] || 'FALSE';
                } else {
                    console.warn(`kill-player: MainUsed column index ${mainUsedCol} is out of bounds for player row ${i}. Defaulting MainUsed status to FALSE.`);
                }
                break;
            }
        }
        console.log(`kill-player: Mafia player ${mafiaPlayerId} found at row ${mafiaPlayerRowIndex}. MainUsed status: ${mafiaMainUsedStatus}`);

        if (mafiaPlayerRowIndex === -1) {
            console.log("kill-player: Mafia player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found.' }) };
        }
        if (mafiaMainUsedStatus === 'TRUE') {
            console.log("kill-player: Mafia has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }

        // 2. Get current day
        console.log("kill-player: Fetching current day from Game_State sheet.");
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`kill-player: Current Day: ${currentDay}`);

        // 3. Log the action (two separate entries)
        const timestamp = new Date().toISOString();
        const actionId1 = `ACT_KILL_${Date.now()}_1`;
        const actionId2 = `ACT_KILL_${Date.now()}_2`;

        const newActionRow1 = [actionId1, currentDay, mafiaPlayerId, targetPlayerId1, timestamp, null, 'Logged'];
        const newActionRow2 = [actionId2, currentDay, mafiaPlayerId, targetPlayerId2, timestamp, null, 'Logged'];

        console.log("kill-player: Appending action for Target 1 to Actions_Mafia sheet.");
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Mafia!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow1] },
        });
        console.log("kill-player: Action logged for Target 1.");

        console.log("kill-player: Appending action for Target 2 to Actions_Mafia sheet.");
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Mafia!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow2] },
        });
        console.log("kill-player: Action logged for Target 2.");

        // 4. Update the Mafia player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${mafiaPlayerRowIndex}`;
        console.log(`kill-player: Updating Mafia's MainUsed status for ${mafiaPlayerId} at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });
        console.log(`kill-player: Mafia's MainUsed status for ${mafiaPlayerId} updated to TRUE.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Kill action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('kill-player: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log kill action.', details: error.message }),
        };
    } finally {
        console.log("kill-player: Function finished.");
    }
};