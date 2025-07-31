// netlify/functions/get-player-name.js

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
    console.log("get-player-name: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-player-name: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-name: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const playerId = event.queryStringParameters.playerId;
    if (!playerId) {
        console.log("get-player-name: Missing playerId query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:B', // Fetch only PlayerID (A) and Name (B)
        });

        const allPlayersRawData = playersResponse.data.values || [];
        if (allPlayersRawData.length < 1) {
            console.log("get-player-name: Players sheet is empty.");
            return { statusCode: 404, body: JSON.stringify({ error: 'No players found in sheet.' }) };
        }

        const headers = allPlayersRawData[0];
        const playerRows = allPlayersRawData.slice(1);

        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name');

        if (idCol === -1 || nameCol === -1) {
            console.error("get-player-name: Required columns 'PlayerID' or 'Name' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'Name' not found in Players sheet.");
        }

        let playerName = 'N/A';
        for (const row of playerRows) {
            const currentPlayerId = row[idCol] ? String(row[idCol]).trim() : '';
            if (currentPlayerId === playerId) {
                playerName = row[nameCol] ? String(row[nameCol]).trim() : 'N/A';
                break;
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerName: playerName }),
        };

    } catch (error) {
        console.error('get-player-name: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player name.', details: error.message }),
        };
    } finally {
    }
};