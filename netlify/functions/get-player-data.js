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

exports.handler = async (event, context) => {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-data: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const range = 'Players!A:X'; // Read all necessary columns
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([]),
            };
        }

        const headers = values[0];
        const dataRows = values.slice(1);

        // A more robust way to parse the data
        const playerData = dataRows.map(row => {
            const player = {};
            // Only process rows that have a PlayerID in the first column
            if (row[0]) { 
                headers.forEach((header, index) => {
                    const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
                    player[cleanHeader] = row[index] || null;
                });
            }
            return player;
        }).filter(player => player.PlayerID); // Filter out any empty objects

        console.log(`get-player-data: Successfully parsed ${playerData.length} players.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(playerData),
        };

    } catch (error) {
        console.error('Error in get-player-data function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player data.', details: error.message }),
        };
    }
};
