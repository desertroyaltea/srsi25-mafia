// netlify/functions/get-player-data.js

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

// Define CORS headers that will be used in all responses
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async (event, context) => {
    // Handle preflight requests for CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'CORS preflight successful' }),
        };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-data: Google Sheet ID is not configured.");
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();
        const range = 'Players!A:X';
        console.log(`get-player-data: Fetching range "${range}"`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;

        if (!values || values.length < 2) {
            console.error('get-player-data: No data found in Players sheet or only headers are present.');
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify([]),
            };
        }

        const dataHeaders = values[0];
        const dataRows = values.slice(1).filter(row => row[0]); // Ensure row has a PlayerID

        const playerData = dataRows.map(row => {
            const player = {};
            dataHeaders.forEach((header, index) => {
                const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
                player[cleanHeader] = row[index] || null;
            });
            return player;
        });

        console.log(`get-player-data: Successfully parsed ${playerData.length} players.`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(playerData),
        };

    } catch (error) {
        console.error('Error in get-player-data function:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch player data.', details: error.message }),
        };
    }
};
