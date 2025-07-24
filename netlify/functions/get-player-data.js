// netlify/functions/get-player-data.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;

const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    try {
        if (!sheetId) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Google Sheet ID is not configured.' }),
            };
        }

        const range = 'Players!A:Z'; // Reads all columns from the Players sheet

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;

        if (!values || values.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ message: 'No player data found.' }),
            };
        }

        const headers = values[0];
        const playerData = values.slice(1).map(row => {
            const player = {};
            headers.forEach((header, index) => {
                const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
                player[cleanHeader] = row[index];
            });
            return player;
        });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(playerData),
        };

    } catch (error) {
        console.error('Error fetching player data:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player data', details: error.message }),
        };
    }
};
