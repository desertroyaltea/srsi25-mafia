// netlify/functions/get-game-state.js

// This version tries to log even before parsing credentials, and handles potential parsing errors.

let credentials;
let sheetId;

try {
    console.log('--- get-game-state.js: Attempting initial setup ---');
    // Attempt to parse credentials. This is the most common point of failure for empty logs.
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    sheetId = process.env.GOOGLE_SHEET_ID;
    console.log('--- get-game-state.js: Credentials parsed successfully ---');
    console.log(`Test: GOOGLE_SHEET_ID is: ${sheetId || 'NOT_SET'}`);

} catch (e) {
    console.error('--- get-game-state.js: CRITICAL ERROR during initial setup (JSON.parse or env access) ---', e);
    // If parsing fails, set dummy credentials so the handler can still return an error
    credentials = { client_email: 'error@example.com', private_key: 'dummy' };
    sheetId = 'ERROR_LOADING';
}

// Now, define the handler function
exports.handler = async (event, context) => {
    try {
        console.log('--- get-game-state.js: Handler invoked ---');
        
        if (sheetId === 'ERROR_LOADING') {
            console.error('--- get-game-state.js: Handler detected initial setup error ---');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Function failed to load environment variables correctly. Check Netlify logs for critical errors.' }),
            };
        }

        // --- Original minimal logic (will be re-added later if this works) ---
        // const { google } = require('googleapis');
        // const { JWT } = require('google-auth-library');
        // const auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
        // const sheets = google.sheets({ version: 'v4', auth });
        // const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Game_State!A1:G2' });
        // const values = response.data.values;
        // console.log('Raw values from sheet (Game_State):', values);
        // --- End original minimal logic ---

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({ message: 'Function response. Check Netlify logs for execution details.' }),
        };

    } catch (error) {
        console.error('--- get-game-state.js: UNEXPECTED ERROR during handler execution ---', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Function failed during execution. Check Netlify logs.' }),
        };
    }
};
