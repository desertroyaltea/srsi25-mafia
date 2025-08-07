// File: netlify/functions/identify-onesignal-user.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const fetch = require('node-fetch'); // You may need to add 'node-fetch' to your package.json

// --- Google Sheets Helper (Same as before) ---
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

    const { playerId, oneSignalId } = JSON.parse(event.body);
    const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID; // Add your App ID to Netlify
    const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY; // Add your REST API Key to Netlify

    if (!playerId || !oneSignalId || !ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
        return { statusCode: 400, body: 'Missing required data or server configuration.' };
    }

    try {
        // --- Task 1: Identify the user using the OneSignal REST API ---
        await fetch(`https://onesignal.com/api/v1/apps/${ONESIGNAL_APP_ID}/users/by/onesignal_id/${oneSignalId}/identity`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONESIGNAL_API_KEY}`
            },
            body: JSON.stringify({
                identity: {
                    external_id: playerId
                }
            })
        });

        // --- Task 2: Save the mapping to Google Sheets (your existing logic) ---
        const sheets = await getSheetsService();
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'OneSignal!A:C',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[playerId, null, oneSignalId]]
            }
        });

        return { statusCode: 200, body: 'User identified successfully.' };

    } catch (error) {
        console.error('Identify User Error:', error);
        return { statusCode: 500, body: 'An error occurred.' };
    }
};