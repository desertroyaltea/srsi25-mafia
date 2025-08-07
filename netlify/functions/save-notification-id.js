// netlify/functions/save-notification-id.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// This helper function remains the same
async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let playerId, oneSignalId;
    try {
        const body = JSON.parse(event.body);
        playerId = body.playerId;
        oneSignalId = body.oneSignalId;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!playerId || !oneSignalId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing player ID or OneSignal ID.' }) };
    }

    try {
        const sheets = await getSheetsService();
        
        // We will append a new row to the 'OneSignal' sheet.
        // The data is an array within an array. The inner array represents the row.
        // We use 'null' as a placeholder to skip column B.
        const values = [[playerId, null, oneSignalId]];

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'OneSignal!A:C', // The sheet and columns to append to
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: values
            }
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Notification ID appended successfully.' }),
        };

    } catch (error) {
        console.error('save-notification-id Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to save notification ID.', details: error.message }),
        };
    }
};