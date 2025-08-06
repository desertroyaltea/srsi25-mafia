// netlify/functions/save-notification-id.js

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

    let playerId, oneSignalId;
    try {
        const body = JSON.parse(event.body);
        playerId = body.playerId;
        oneSignalId = body.oneSignalId;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!playerId || !oneSignalId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing player ID or OneSignal ID.' }) };
    }

    try {
        const sheets = await getSheetsService();
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z',
        });

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const oneSignalCol = playerHeaders.indexOf('OneSignalPlayerID');

        if (idCol === -1 || oneSignalCol === -1) {
            throw new Error('Required columns (PlayerID, OneSignalPlayerID) not found in Players sheet.');
        }

        let playerRowIndex = -1;
        for (let i = 0; i < players.length; i++) {
            if (String(players[i][idCol]).trim() === playerId) {
                playerRowIndex = i + 2; // 1-based index for sheet ranges
                break;
            }
        }

        if (playerRowIndex === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }

        const range = `Players!${String.fromCharCode(65 + oneSignalCol)}${playerRowIndex}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[oneSignalId]]
            }
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Notification ID saved successfully.' }),
        };

    } catch (error) {
        console.error('save-notification-id Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to save notification ID.', details: error.message }),
        };
    }
};
