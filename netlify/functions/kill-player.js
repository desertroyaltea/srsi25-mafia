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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { mafiaPlayerId, targetPlayerId } = JSON.parse(event.body);
        if (!mafiaPlayerId || !targetPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Check if the player has already used their action
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:T', // Read up to MainUsed column
        });
        const players = playersResponse.data.values || [];
        const playerHeaders = players[0];
        const idCol = playerHeaders.indexOf('PlayerID');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');

        let playerRowIndex = -1;
        for(let i = 0; i < players.length; i++) {
            if(players[i][idCol] === mafiaPlayerId) {
                playerRowIndex = i + 1; // 1-based index for sheet ranges
                if(players[i][mainUsedCol] === 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
                }
                break;
            }
        }
        if (playerRowIndex === -1) {
             return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }

        // 2. Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values ? gameStateResponse.data.values[0][0] : 'Unknown';

        // 3. Log the action
        const newActionRow = [`ACT_KILL_${Date.now()}`, currentDay, mafiaPlayerId, 'Kill', targetPlayerId, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Mafia!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });

        // 4. Update the player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${playerRowIndex}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Kill action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('Error in kill-player function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log kill action.', details: error.message }),
        };
    }
};
