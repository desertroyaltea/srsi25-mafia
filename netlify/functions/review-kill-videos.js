// File: netlify/functions/review-kill-videos.js

const { google } = require('googleapis');

async function getAuthenticatedClient(scopes) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "https://developers.google.com/oauthplayground");
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    return oauth2Client;
}

exports.handler = async (event) => {
    try {
        const auth = await getAuthenticatedClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
        const sheets = google.sheets({ version: 'v4', auth });

        const [killData, playerData] = await Promise.all([
            sheets.spreadsheets.values.get({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: 'Video_Kill!A:F',
            }),
            sheets.spreadsheets.values.get({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: 'Players!A:B',
            })
        ]);

        const kills = killData.data.values || [];
        const players = playerData.data.values || [];
        const playerMap = new Map(players.map(p => [p[0], p[1]]));

        const pendingKills = kills
            .filter(row => row[5] === 'Pending') // Filter by Status in column F
            .map(row => ({
                ActionID: row[0],
                Day: row[1],
                MafiaPlayerID: row[2],
                TargetPlayerID: row[3],
                Timestamp: row[4],
                Status: row[5],
                FileID: row[3], // Assuming FileID is logged in the same column as TargetPlayerID for now
                MafiaPlayerName: playerMap.get(row[2]) || 'Unknown',
                TargetPlayerName: playerMap.get(row[3]) || 'Unknown',
            }));
            
        // A correction to get the FileID from the Actions_Mafia sheet
        const actionsData = await sheets.spreadsheets.values.get({
             spreadsheetId: process.env.GOOGLE_SHEET_ID,
             range: 'Actions_Mafia!A:D',
        });
        const actions = actionsData.data.values || [];
        const actionMap = new Map(actions.map(a => [a[0], a[3]])); // ActionID -> Details

        pendingKills.forEach(kill => {
            const details = actionMap.get(kill.ActionID);
            if (details && details.startsWith('FileID: ')) {
                 kill.FileID = details.replace('FileID: ', '').trim();
            }
        });


        return {
            statusCode: 200,
            body: JSON.stringify(pendingKills),
        };

    } catch (error) {
        console.error('Error fetching pending kills:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch pending kills.' }) };
    }
};
