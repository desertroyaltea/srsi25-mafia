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
        const { actionId, status } = JSON.parse(event.body);
        if (!actionId || !status) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing actionId or status.' }) };
        }

        const auth = await getAuthenticatedClient(['https://www.googleapis.com/auth/spreadsheets']);
        const sheets = google.sheets({ version: 'v4', auth });

        // Get all data needed in one go
        const [killData, playersData] = await Promise.all([
            sheets.spreadsheets.values.get({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: 'Video_Kill!A:F',
            }),
            sheets.spreadsheets.values.get({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: 'Players!A:E', // Read up to column E
            })
        ]);
        
        const kills = killData.data.values || [];
        const allPlayers = playersData.data.values || [];

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
                // FIX: Update player status to "Dead" in Players sheet (column E)
                await sheets.spreadsheets.values.update({
                    spreadsheetId: process.env.GOOGLE_SHEET_ID,
                    range: `Players!E${targetPlayerRowIndex + 1}`,
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
