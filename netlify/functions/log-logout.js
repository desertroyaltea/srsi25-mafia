// netlify/functions/log-logout.js

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
        console.error("log-logout: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let sessionId;
    try {
        const body = JSON.parse(event.body);
        sessionId = body.sessionId;
    } catch (e) {
        console.error("log-logout: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!sessionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Session ID is required.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const sessionsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sessions!A:F', // Fetch up to Status (F)
        });

        const allSessions = sessionsResponse.data.values || [];
        if (allSessions.length < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No sessions found.' }) };
        }

        const headers = allSessions[0];
        const sessionRows = allSessions.slice(1);

        const sessionIdCol = headers.indexOf('SessionID');
        const logoutTimeCol = headers.indexOf('LogoutTime');
        const statusCol = headers.indexOf('Status');

        if (sessionIdCol === -1 || logoutTimeCol === -1 || statusCol === -1) {
            console.error("log-logout: Required columns 'SessionID', 'LogoutTime', or 'Status' not found in Sessions sheet.");
            throw new Error("Required columns 'SessionID', 'LogoutTime', or 'Status' not found in Sessions sheet.");
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

        const newLogoutTime = new Date().toISOString();
        const newStatus = 'Logged Out';

        // Use batchUpdate for efficiency if updating multiple cells, or individual setValue
        // Given it's just two cells, setValue is fine, but batchUpdate is more robust for future changes
        const requests = [
            {
                range: `Sessions!${String.fromCharCode(65 + logoutTimeCol)}${sessionRowIndex}`,
                values: [[newLogoutTime]]
            },
            {
                range: `Sessions!${String.fromCharCode(65 + statusCol)}${sessionRowIndex}`,
                values: [[newStatus]]
            }
        ];

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Logout logged successfully.' }),
        };

    } catch (error) {
        console.error('log-logout: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log logout.', details: error.message }),
        };
    } finally {
    }
};