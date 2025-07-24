// netlify/functions/protect-player.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("protect-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { doctorPlayerId, protectedPlayerId } = JSON.parse(event.body);
        if (!doctorPlayerId || !protectedPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId or protectedPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Get the current day from the Game_State sheet
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2', // Assuming CurrentDay is in cell A2
        });
        const currentDay = gameStateResponse.data.values ? gameStateResponse.data.values[0][0] : 'Unknown';

        // 2. Prepare the new row for the Actions_Doctor sheet
        const actionId = `ACT_PROTECT_${Date.now()}`;
        const timestamp = new Date().toISOString();
        const status = 'Protected';

        const newActionRow = [
            actionId,
            currentDay,
            doctorPlayerId,
            protectedPlayerId,
            timestamp,
            null, // RevivedPlayerID - not used in this action
            status
        ];

        // 3. Append the new row to the Actions_Doctor sheet
        console.log(`protect-player: Logging protection action from ${doctorPlayerId} on ${protectedPlayerId}`);
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Doctor!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [newActionRow],
            },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Protection action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('Error in protect-player function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log protection action.', details: error.message }),
        };
    }
};
