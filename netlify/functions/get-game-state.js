// netlify/functions/get-game-state.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
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
        console.error("get-game-state: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Fetch all data from the Game_State sheet to find the last row.
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A:G',
        });

        const allRows = response.data.values || [];
        if (allRows.length < 2) {
            throw new Error("Game_State sheet is empty or has no data headers.");
        }

        const headers = allRows[0];
        // 2. The definitive current state is the LAST row in the sheet.
        const latestRow = allRows[allRows.length - 1];

        // 3. Parse the correct row into a game state object
        const gameState = {};
        headers.forEach((header, index) => {
            const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
            gameState[cleanHeader] = latestRow[index] || null;
        });
        
        console.log('Parsed game state object from the last row:', gameState);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(gameState),
        };

    } catch (error) {
        console.error('Error in get-game-state function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch game state.', details: error.message }),
        };
    }
};
