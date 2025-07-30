// netlify/functions/get-game-state.js

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
    console.log("get-game-state: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-game-state: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-game-state: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`get-game-state: Sheet ID: ${sheetId}`);

    try {
        const sheets = await getSheetsService();
        console.log("get-game-state: Sheets service initialized.");

        // CRITICAL FIX: Fetch the Winner cell (H2) as well
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:H2', // Fetch from A2 to H2 to get all relevant cells
        });

        const row = gameStateResponse.data.values ? gameStateResponse.data.values[0] : [];
        
        // Ensure mapping matches the order of columns in Game_State!A2:H2
        const gameState = {
            CurrentDay: row[0] || '1', // A2
            CurrentPhase: row[1] || 'Day', // B2
            PhaseDeadline: row[2] || '', // C2 (assuming C2 is PhaseDeadline)
            LastAccusedPlayerID: row[4] || 'N/A', // E2
            LastTrialResult: row[5] || 'N/A', // F2
            JesterKilledByVote: row[6] || 'FALSE', // G2
            Winner: row[7] || '' // H2 - NEW: Winner column
        };
        console.log("get-game-state: Fetched game state:", gameState);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(gameState),
        };

    } catch (error) {
        console.error('get-game-state: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch game state.', details: error.message }),
        };
    } finally {
        console.log("get-game-state: Function finished.");
    }
};