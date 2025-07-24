// netlify/functions/get-game-state.js

// This version correctly fetches the single row of data from the 'Game_State' sheet.

let credentials;
let sheetId;

try {
    console.log('--- get-game-state.js: Attempting initial setup ---');
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    sheetId = process.env.GOOGLE_SHEET_ID;
    console.log('--- get-game-state.js: Credentials parsed successfully ---');
} catch (e) {
    console.error('--- get-game-state.js: CRITICAL ERROR during initial setup ---', e);
    credentials = { client_email: 'error@example.com', private_key: 'dummy' };
    sheetId = 'ERROR_LOADING';
}

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

exports.handler = async (event, context) => {
    try {
        console.log('--- get-game-state.js: Handler invoked ---');
        
        if (sheetId === 'ERROR_LOADING') {
            console.error('--- get-game-state.js: Handler detected initial setup error ---');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Function failed to load environment variables correctly.' }),
            };
        }

        const auth = new JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });

        const sheets = google.sheets({ version: 'v4', auth });

        // Correctly target the Game_State sheet. We fetch A1:Z to get headers and all data rows.
        const range = 'Game_State!A1:Z'; 

        console.log(`Attempting to fetch data from Sheet ID: ${sheetId}, Range: ${range}`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;
        console.log('Raw values from sheet (Game_State):', values);

        // We need at least 2 rows: one for headers and one for the data.
        if (!values || values.length < 2) {
            console.log('No game state data found or sheet is malformed. Needs headers and one data row.');
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Game state not found.' }),
            };
        }

        const headers = values[0];
        const dataRow = values[1]; // The actual game state data is the second row
        
        const gameState = {};
        headers.forEach((header, index) => {
            // Clean header name to be a valid JS property name
            const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
            gameState[cleanHeader] = dataRow[index] || null; // Use null for empty cells
        });

        console.log('Parsed game state object:', gameState);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            // Return a single JSON object, not an array
            body: JSON.stringify(gameState),
        };

    } catch (error) {
        console.error('--- get-game-state.js: UNEXPECTED ERROR during handler execution ---', error);
        let errorMessage = 'Failed to fetch game state.';
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `Google API Error: ${error.response.data.error.message || error.message}`;
        } else if (error.message) {
            errorMessage = `Internal Server Error: ${error.message}`;
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};
