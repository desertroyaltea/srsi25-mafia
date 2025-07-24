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

        // 1. Check if the detective has already used their action
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:T',
        });
        const players = playersResponse.data.values || [];
        const playerHeaders = players[0];
        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');

        let playerRowIndex = -1;
        for(let i = 0; i < players.length; i++) {
            if(players[i][idCol] === detectivePlayerId) {
                playerRowIndex = i + 1; // 1-based index
                if(players[i][mainUsedCol] === 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
                }
                break;
            }
        }
        if (playerRowIndex === -1) {
             return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }
        
        // 2. Find the target's role
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

        // 3. Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values ? gameStateResponse.data.values[0][0] : 'Unknown';

        // 4. Log the action
        const newActionRow = [`ACT_CHECK_${Date.now()}`, currentDay, detectivePlayerId, checkedPlayerId, isMafiaResult, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Detective!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });

        // 5. Update the detective's MainUsed status to TRUE
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
            body: JSON.stringify({ 
                message: 'Investigation has been logged.',
                isMafiaResult: isMafiaResult // Return the result to the frontend
            }),
        };

    } catch (error) {
        console.error('Error in check-mafia function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log investigation.', details: error.message }),
        };
    }
};
