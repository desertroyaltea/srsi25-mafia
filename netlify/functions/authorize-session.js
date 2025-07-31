// netlify/functions/authorize-session.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only scope
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("authorize-session: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let sessionId;
    try {
        const body = JSON.parse(event.body);
        sessionId = body.sessionId;
    } catch (e) {
        console.error("authorize-session: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!sessionId) {
        console.log("authorize-session: Missing sessionId in request body.");
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
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: No active sessions found.' }) };
        }

        const headers = allSessions[0];
        const sessionRows = allSessions.slice(1);

        const sessionIdCol = headers.indexOf('SessionID');
        const playerIdCol = headers.indexOf('PlayerID'); // Get PlayerID from session
        const statusCol = headers.indexOf('Status');
        const lastActivityTimeCol = headers.indexOf('LastActivityTime'); // For potential expiry check

        if ([sessionIdCol, playerIdCol, statusCol, lastActivityTimeCol].includes(-1)) {
            console.error("authorize-session: Required columns not found in Sessions sheet.");
            throw new Error("Required columns (SessionID, PlayerID, Status, LastActivityTime) not found in Sessions sheet.");
        }

        let authorizedPlayerId = null;
        for (const row of sessionRows) {
            const currentSessionId = row[sessionIdCol] ? String(row[sessionIdCol]).trim() : '';
            const sessionStatus = row[statusCol] ? String(row[statusCol]).trim() : '';
            const sessionPlayerId = row[playerIdCol] ? String(row[playerIdCol]).trim() : '';
            const lastActivityTime = row[lastActivityTimeCol] ? new Date(row[lastActivityTimeCol]) : null;

            if (currentSessionId === sessionId && sessionStatus === 'Active') {
                // Optional: Add session expiry check here (e.g., if lastActivityTime is too old)
                // const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
                // if (lastActivityTime && (Date.now() - lastActivityTime.getTime() > SESSION_TIMEOUT_MS)) {
                //     console.warn(`authorize-session: Session ${sessionId} expired due to inactivity.`);
                //     // You might want to update session status to 'Expired' in the sheet here
                //     return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Session expired.' }) };
                // }
                authorizedPlayerId = sessionPlayerId;
                break;
            }
        }

        if (authorizedPlayerId) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Session authorized.', authorizedPlayerId: authorizedPlayerId }),
            };
        } else {
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid or inactive session.' }) };
        }

    } catch (error) {
        console.error('authorize-session: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Session authorization failed.', details: error.message }),
        };
    } finally {
    }
};