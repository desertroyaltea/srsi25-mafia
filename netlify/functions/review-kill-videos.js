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
                range: 'Video_Kill!A:G', // Read up to the Link column
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
            .map(row => {
                const webViewLink = row[6] || '';
                let embedLink = '';

                // Extract file ID from the link, e.g., https://drive.google.com/file/d/FILE_ID/view?usp=sharing
                const fileIdMatch = webViewLink.match(/d\/(.*?)\//);
                if (fileIdMatch && fileIdMatch[1]) {
                    const fileId = fileIdMatch[1];
                    embedLink = `https://drive.google.com/file/d/${fileId}/preview`;
                }

                return {
                    ActionID: row[0],
                    Day: row[1],
                    MafiaPlayerID: row[2],
                    TargetPlayerID: row[3],
                    Timestamp: row[4],
                    Status: row[5],
                    embedLink: embedLink, // Provide the embeddable link to the frontend
                    MafiaPlayerName: playerMap.get(row[2]) || 'Unknown',
                    TargetPlayerName: playerMap.get(row[3]) || 'Unknown',
                };
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
