// netlify/functions/update-session-activity.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Full access for writing
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("update-session-activity: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let sessionId;
    try {
        const body = JSON.parse(event.body);
        sessionId = body.sessionId;
    } catch (e) {
        console.error("update-session-activity: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!sessionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Session ID is required.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const sessionsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sessions!A:D', // Fetch up to LastActivityTime (D)
        });

        const allSessions = sessionsResponse.data.values || [];
        if (allSessions.length < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No sessions found.' }) };
        }

        const headers = allSessions[0];
        const sessionRows = allSessions.slice(1);

        const sessionIdCol = headers.indexOf('SessionID');
        const lastActivityTimeCol = headers.indexOf('LastActivityTime');

        if (sessionIdCol === -1 || lastActivityTimeCol === -1) {
            console.error("update-session-activity: Required columns 'SessionID' or 'LastActivityTime' not found in Sessions sheet.");
            throw new Error("Required columns 'SessionID' or 'LastActivityTime' not found in Sessions sheet.");
        }

        let sessionRowIndex = -1;
        for (let i = 0; i < sessionRows.length; i++) {
            if (sessionRows[i][sessionIdCol] === sessionId) {
                sessionRowIndex = i + 2; // +2 for 0-index and header row
                break;
            }
        }

        if (sessionRowIndex === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Session not found.' }) };
        }

        const newLastActivityTime = new Date().toISOString();
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `Sessions!${String.fromCharCode(65 + lastActivityTimeCol)}${sessionRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[newLastActivityTime]] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Session activity updated successfully.' }),
        };

    } catch (error) {
        console.error('update-session-activity: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update session activity.', details: error.message }),
        };
    } finally {
    }
};