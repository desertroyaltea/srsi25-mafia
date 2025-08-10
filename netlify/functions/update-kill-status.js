// File: netlify/functions/update-kill-status.js

const { google } = require('googleapis');

async function getAuthenticatedClient(scopes) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "https://developers.google.com/oauthplayground");
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    return oauth2Client;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const { actionId, status, adminPlayerId, sessionId } = JSON.parse(event.body);
        if (!actionId || !status || !adminPlayerId || !sessionId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
        }

        const auth = await getAuthenticatedClient(['https://www.googleapis.com/auth/spreadsheets']);
        const sheets = google.sheets({ version: 'v4', auth });

        // Verify admin status and session
        const playersData = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Players!A:F', // Read up to SessionID column
        });
        const allPlayers = playersData.data.values || [];
        const adminRow = allPlayers.find(p => p[0] === adminPlayerId);

        if (!adminRow) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized: Admin user not found.' }) };
        }

        const isAdmin = (adminRow[2] || '').trim().toUpperCase() === 'TRUE'; // IsAdmin is in Column C
        const isValidSession = adminRow[5] === sessionId; // SessionID is in Column F

        if (!isAdmin || !isValidSession) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized.' }) };
        }

        const killData = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Video_Kill!A:F',
        });

        const kills = killData.data.values || [];
        const killRowIndex = kills.findIndex(row => row[0] === actionId);

        if (killRowIndex === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Kill action not found.' }) };
        }

        const targetPlayerId = kills[killRowIndex][3]; // TargetPlayerID is in column D

        // Update status in Video_Kill sheet (column F)
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `Video_Kill!F${killRowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[status]] },
        });

        if (status === 'Accepted') {
            const targetPlayerRowIndex = allPlayers.findIndex(p => p[0] === targetPlayerId);
            if (targetPlayerRowIndex !== -1) {
                // Update player status to "Dead" in Players sheet (column B)
                await sheets.spreadsheets.values.update({
                    spreadsheetId: process.env.GOOGLE_SHEET_ID,
                    range: `Players!B${targetPlayerRowIndex + 1}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [['Dead']] },
                });
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Kill status updated to ${status}.` }),
        };

    } catch (error) {
        console.error('Error updating kill status:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update kill status.' }) };
    }
};
