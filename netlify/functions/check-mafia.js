// netlify/functions/check-mafia.js

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
        const { detectivePlayerId, checkedPlayerId } = JSON.parse(event.body);
        if (!detectivePlayerId || !checkedPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing detectivePlayerId or checkedPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Get all player data to find the target's role
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:C', // PlayerID, Name, Role
        });
        const players = playersResponse.data.values || [];
        const playerHeaders = players[0];
        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');

        let targetRole = null;
        for (const playerRow of players.slice(1)) {
            if (playerRow[idCol] === checkedPlayerId) {
                targetRole = playerRow[roleCol];
                break;
            }
        }

        if (!targetRole) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Target player not found.' }) };
        }

        const isMafiaResult = (targetRole.toLowerCase() === 'mafia') ? 'YES' : 'NO';

        // 2. Get the current day from Game_State
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values ? gameStateResponse.data.values[0][0] : 'Unknown';

        // 3. Prepare and append the new row to Actions_Detective
        const newActionRow = [
            `ACT_CHECK_${Date.now()}`, // ActionID
            currentDay,
            detectivePlayerId,
            checkedPlayerId,
            isMafiaResult, // Result
            new Date().toISOString() // Timestamp
        ];

        console.log(`check-mafia: Logging check action from ${detectivePlayerId} on ${checkedPlayerId}. Result: ${isMafiaResult}`);
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Detective!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [newActionRow],
            },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Investigation has been logged.' }),
        };

    } catch (error) {
        console.error('Error in check-mafia function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log investigation.', details: error.message }),
        };
    }
};
