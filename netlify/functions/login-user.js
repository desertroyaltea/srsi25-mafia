// netlify/functions/get-player-data.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error.' }),
        };
    }

    try {
        const { playerId } = JSON.parse(event.body);
        if (!playerId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Player ID is required.' }),
            };
        }

        const sheets = await getSheetsService();

        const userSheetRange = 'Users!A:B';
        const userResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: userSheetRange,
        });

        const values = userResponse.data.values;
        if (!values || values.length < 2) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'No users found in the sheet.' }),
            };
        }

        const headers = values[0];
        const users = values.slice(1);
        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name');

        const playerRow = users.find(
            (row) => row[idCol] && row[idCol].trim() === playerId.trim()
        );

        if (!playerRow) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Player ID not found.' }),
            };
        }

        const playerName = playerRow[nameCol];
        const playerSheetName = playerName.trim();

        // Get the first row (header) to determine keys
        const dataRange = `'${playerSheetName}'!A1:1`;
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: dataRange,
        });

        const headersData = headerResponse.data.values?.[0];
        if (!headersData) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to fetch headers from player sheet.' }),
            };
        }

        // Get all player sheet data (excluding header)
        const valuesRange = `'${playerSheetName}'!A2:Z`;
        const valuesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: valuesRange,
        });

        const rows = valuesResponse.data.values || [];

        const formattedData = rows.map((row) => {
            const entry = {};
            headersData.forEach((key, i) => {
                entry[key] = row[i] ?? null;
            });
            return entry;
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: formattedData }),
        };
    } catch (error) {
        console.error('Error in get-player-data:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to fetch player data.',
                details: error.message,
            }),
        };
    }
};
