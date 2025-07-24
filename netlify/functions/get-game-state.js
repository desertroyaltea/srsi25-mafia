// netlify/functions/get-player-data.js

// This version tries to log even before parsing credentials, and handles potential parsing errors.

let credentials;
let sheetId;

try {
    console.log('--- get-player-data.js: Attempting initial setup ---');
    // Attempt to parse credentials. This is the most common point of failure for empty logs.
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    sheetId = process.env.GOOGLE_SHEET_ID;
    console.log('--- get-player-data.js: Credentials parsed successfully ---');
    console.log(`Test: GOOGLE_SHEET_ID is: ${sheetId || 'NOT_SET'}`);

} catch (e) {
    console.error('--- get-player-data.js: CRITICAL ERROR during initial setup (JSON.parse or env access) ---', e);
    // If parsing fails, set dummy credentials so the handler can still return an error
    credentials = { client_email: 'error@example.com', private_key: 'dummy' };
    sheetId = 'ERROR_LOADING';
}

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Now, define the handler function
exports.handler = async (event, context) => {
    try {
        console.log('--- get-player-data.js: Handler invoked ---');
        
        if (sheetId === 'ERROR_LOADING') {
            console.error('--- get-player-data.js: Handler detected initial setup error ---');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Function failed to load environment variables correctly. Check Netlify logs for critical errors.' }),
            };
        }

        const auth = new JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });

        const sheets = google.sheets({ version: 'v4', auth });

        const range = 'Players!A:Z'; // Reads all columns from the Players sheet

        console.log(`Attempting to fetch data from Sheet ID: ${sheetId}, Range: ${range}`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;
        console.log('Raw values from sheet (Players):', values);

        if (!values || values.length === 0) {
            console.log('No player data found. Returning empty array.');
            return {
                statusCode: 404, // Or 200 with empty array, depending on desired frontend behavior
                body: JSON.stringify([]),
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

        console.log('Parsed player data:', playerData);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(playerData),
        };

    } catch (error) {
        console.error('--- get-player-data.js: UNEXPECTED ERROR during handler execution ---', error);
        let errorMessage = 'Failed to fetch player data.';
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `Google API Error: ${error.response.data.error.message || error.message}`;
            console.error('Google API Error Details:', error.response.data.error);
        } else if (error.message) {
            errorMessage = `Internal Server Error: ${error.message}`;
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};
