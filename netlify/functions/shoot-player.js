// netlify/functions/shoot-player.js

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
        const { sheriffPlayerId, killedPlayerId } = JSON.parse(event.body);
        if (!sheriffPlayerId || !killedPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing sheriffPlayerId or killedPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Check Sheriff's status
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:T',
        });
        const players = playersResponse.data.values || [];
        const playerHeaders = players[0];
        const idCol = playerHeaders.indexOf('PlayerID');
        const shotUsedCol = playerHeaders.indexOf('SheriffShotUsed');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');

        let sheriffRowIndex = -1;
        for(let i = 0; i < players.length; i++) {
            if(players[i][idCol] === sheriffPlayerId) {
                sheriffRowIndex = i + 1; // 1-based index
                if(players[i][shotUsedCol] === 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'Sheriff has already used their one-time shot.' }) };
                }
                if(players[i][mainUsedCol] === 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
                }
                break;
            }
        }
        if (sheriffRowIndex === -1) {
             return { statusCode: 404, body: JSON.stringify({ error: 'Sheriff player not found.' }) };
        }

        // 2. Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values ? gameStateResponse.data.values[0][0] : 'Unknown';

        // 3. Log the action
        const newActionRow = [`ACT_SHOOT_${Date.now()}`, currentDay, sheriffPlayerId, killedPlayerId, new Date().toISOString(), 'Used'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Sheriff!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });

        // 4. Update both SheriffShotUsed and MainUsed to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + shotUsedCol)}${sheriffRowIndex}:${String.fromCharCode(65 + mainUsedCol)}${sheriffRowIndex}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE', 'TRUE']] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Sheriff shot has been logged and confirmed.' }),
        };

    } catch (error) {
        console.error('Error in shoot-player function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log sheriff shot.', details: error.message }),
        };
    }
};
