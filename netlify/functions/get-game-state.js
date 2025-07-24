// netlify/functions/get-game-state.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Retrieve environment variables
// GOOGLE_SERVICE_ACCOUNT_CREDENTIALS should be the JSON string of your service account key
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;

// Create a new JWT client for authentication
const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only access to sheets
});

// Initialize the Google Sheets API client
const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    try {
        // Ensure the sheet ID is set
        if (!sheetId) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Google Sheet ID is not configured.' }),
            };
        }

        // Define the range for the Game_State tab.
        // We assume the first row contains headers and the second row contains the actual game state data.
        const range = 'Game_State!A1:G2'; // Adjust 'G' if you add more columns to Game_State tab

        // Fetch data from the Google Sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;

        if (!values || values.length < 2) {
            // No data or only headers found
            return {
                statusCode: 404,
                body: JSON.stringify({ message: 'Game state data not found or sheet is empty.' }),
            };
        }

        // Assuming the first row is headers and the second row is the actual game state data
        const headers = values[0];
        const gameStateData = values[1];

        // Map the data to an object using headers as keys
        const gameState = {};
        headers.forEach((header, index) => {
            // Clean up header names (remove spaces, special chars for easier JS access)
            const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
            gameState[cleanHeader] = gameStateData[index];
        });

        // Return the game state as JSON
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', // Allow requests from any origin (for development)
            },
            body: JSON.stringify(gameState),
        };

    } catch (error) {
        console.error('Error fetching game state:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch game state', details: error.message }),
        };
    }
};
