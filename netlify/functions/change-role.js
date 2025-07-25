// netlify/functions/change-role.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

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
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
const { villagerPlayerId, newRole } = JSON.parse(event.body); // NEW: Receive newRole
        if (!villagerPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing villagerPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Fetch all player data
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:W',
        });

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const canChangeRoleCol = playerHeaders.indexOf('VillagerCanChangeRole');

        // 2. Find the Villager and verify their ability
        let playerRowIndex = -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === villagerPlayerId) {
                if (players[i][canChangeRoleCol] !== 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to change your role.' }) };
                }
                playerRowIndex = i + 2; // 1-based index for sheet ranges
                break;
            }
        }

        if (playerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }


if (!newRole || !['Mafia', 'Doctor', 'Detective'].includes(newRole)) {
            console.log(`change-role: Invalid newRole provided: ${newRole}`);
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid new role selected.' }) };
        }
        console.log(`Villager ${villagerPlayerId} is changing their role to ${newRole}.`);
        // 4. Prepare batch update to change role and remove ability
        const requests = [
            { // Update Role
                range: `Players!${String.fromCharCode(65 + roleCol)}${playerRowIndex}`,
                values: [[newRole]]
            },
            { // Set VillagerCanChangeRole ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canChangeRoleCol)}${playerRowIndex}`,
                values: [['FALSE']]
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
            body: JSON.stringify({ message: `Your role has been changed! You are now a ${newRole}.` }),
        };

    } catch (error) {
        console.error('Error in change-role function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to change role.', details: error.message }),
        };
    }
};
