// netlify/functions/login-user.js

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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { name } = JSON.parse(event.body);
        if (!name) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Player name is required.' }) };
        }

        const sheets = await getSheetsService();

        const range = 'Users!A:B'; // Only read PlayerID and Name from the Users sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;
        if (!values || values.length < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No users found in the sheet.' }) };
        }

        const headers = values[0];
        const users = values.slice(1);
        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name');

        const lowercasedNameInput = name.trim().toLowerCase();
        let foundPlayer = null;

        for (const userRow of users) {
            const sheetName = userRow[nameCol] ? userRow[nameCol].trim().toLowerCase() : '';
            if (sheetName === lowercasedNameInput) {
                foundPlayer = {
                    playerId: userRow[idCol],
                    playerName: userRow[nameCol]
                };
                break;
            }
        }

        if (foundPlayer) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(foundPlayer),
            };
        } else {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid Player Name. Please try again.' }),
            };
        }

    } catch (error) {
        console.error('Error in login-user function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process login.', details: error.message }),
        };
    }
};
