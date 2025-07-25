// netlify/functions/protect-player.js

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
    console.log("protect-player: Function started."); // LOG 1
    if (event.httpMethod !== 'POST') {
        console.log("protect-player: Method Not Allowed."); // LOG 2
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("protect-player: Google Sheet ID is not configured."); // LOG 3
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`protect-player: Sheet ID: ${sheetId}`); // LOG 4

    try {
        const { doctorPlayerId, targetPlayerId } = JSON.parse(event.body); // Renamed protectedPlayerId to targetPlayerId for consistency with frontend
        console.log(`protect-player: Received - Doctor: ${doctorPlayerId}, Target: ${targetPlayerId}`); // LOG 5
        if (!doctorPlayerId || !targetPlayerId) {
            console.log("protect-player: Missing doctorPlayerId or targetPlayerId."); // LOG 6
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();
        console.log("protect-player: Sheets service initialized."); // LOG 7

        // 1. Check if the player has already used their action
        console.log("protect-player: Fetching Players sheet for action usage check."); // LOG 8
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'MainUsed' is found
        });
        const players = playersResponse.data.values || [];
        if (players.length < 1) {
            console.error("protect-player: Players sheet is empty."); // LOG 9
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = players[0];
        const playerRows = players.slice(1);
        const idCol = playerHeaders.indexOf('PlayerID');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');

        console.log(`protect-player: PlayerID column index: ${idCol}, MainUsed column index: ${mainUsedCol}`); // LOG 10

        if (idCol === -1 || mainUsedCol === -1) {
            console.error("protect-player: Required columns 'PlayerID' or 'MainUsed' not found in Players sheet."); // LOG 11
            throw new Error("Required columns 'PlayerID' or 'MainUsed' not found in Players sheet.");
        }

        let doctorPlayerRowIndex = -1;
        let doctorMainUsedStatus = 'FALSE'; // Default
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === doctorPlayerId) {
                doctorPlayerRowIndex = i + 2; // +2 for 0-index and header row
                doctorMainUsedStatus = playerRows[i][mainUsedCol] || 'FALSE';
                break;
            }
        }
        console.log(`protect-player: Doctor ${doctorPlayerId} found at row ${doctorPlayerRowIndex}. MainUsed status: ${doctorMainUsedStatus}`); // LOG 12

        if (doctorPlayerRowIndex === -1) {
            console.log("protect-player: Doctor player not found in sheet."); // LOG 13
            return { statusCode: 404, body: JSON.stringify({ error: 'Doctor player not found.' }) };
        }
        if (doctorMainUsedStatus === 'TRUE') {
            console.log("protect-player: Doctor has already used action for tonight."); // LOG 14
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }

        // 2. Get current day
        console.log("protect-player: Fetching current day from Game_State sheet."); // LOG 15
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2', // Assuming CurrentDay is in A2
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`protect-player: Current Day: ${currentDay}`); // LOG 16

        // 3. Log the action
        console.log("protect-player: Appending action to Actions_Doctor sheet."); // LOG 17
        const newActionRow = [`ACT_PROTECT_${Date.now()}`, currentDay, doctorPlayerId, targetPlayerId, new Date().toISOString(), null, 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Doctor!A:G', // Ensure this range covers all columns you're writing
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });
        console.log("protect-player: Action logged to Actions_Doctor sheet."); // LOG 18

        // 4. Update the player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${doctorPlayerRowIndex}`;
        console.log(`protect-player: Updating Doctor's MainUsed status at range: ${updateRange}`); // LOG 19
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });
        console.log("protect-player: Doctor's MainUsed status updated to TRUE."); // LOG 20

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Protection action has been successfully logged and action marked as used.' }),
        };

    } catch (error) {
        console.error('protect-player: Error in try-catch block:', error); // LOG 21
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log protection action.', details: error.message }),
        };
    } finally {
        console.log("protect-player: Function finished."); // LOG 22
    }
};