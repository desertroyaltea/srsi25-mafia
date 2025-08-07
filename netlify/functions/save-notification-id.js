// File: netlify/functions/save-notification-id.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { playerId, oneSignalId } = JSON.parse(event.body);

        if (!playerId || !oneSignalId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing player ID or OneSignal ID.' }) };
        }

        const sheets = await getSheetsService();
        const values = [[playerId, null, oneSignalId]]; // Column A: playerId, C: oneSignalId

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'OneSignal!A:C', // Appends to the 'OneSignal' sheet
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: values
            }
        });

        return {
            statusCode: 200,
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