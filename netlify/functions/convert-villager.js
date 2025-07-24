// netlify/functions/convert-villager.js

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
        const { mafiaPlayerId } = JSON.parse(event.body);
        if (!mafiaPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId.' }) };
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
        const statusCol = playerHeaders.indexOf('Status');
        const canConvertCol = playerHeaders.indexOf('MafiaCanConvert');

        // 2. Find the Mafia player and verify their ability
        let mafiaPlayerRowIndex = -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === mafiaPlayerId) {
                if (players[i][canConvertCol] !== 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to convert a villager.' }) };
                }
                mafiaPlayerRowIndex = i + 2; // 1-based index for sheet ranges
                break;
            }
        }

        if (mafiaPlayerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found.' }) };
        }

        // 3. Find all eligible targets (Alive, normal Villagers)
        const eligibleTargets = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (player[statusCol] === 'Alive' && player[roleCol] === 'Villager') {
                // Ensure they are not special roles like Jester or Sheriff by checking their original role if needed
                // For simplicity here, we assume any player with Role='Villager' is a normal one.
                eligibleTargets.push({
                    rowIndex: i + 2, // 1-based index for sheet ranges
                    id: player[idCol],
                    name: player[playerHeaders.indexOf('Name')]
                });
            }
        }

        if (eligibleTargets.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No eligible villagers to convert.' }) };
        }

        // 4. Select a random target
        const randomTarget = eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
        console.log(`Mafia ${mafiaPlayerId} is converting villager ${randomTarget.id} (${randomTarget.name})`);

        // 5. Prepare batch update to convert villager and remove Mafia's ability
        const requests = [
            { // Update Villager's role to Mafia
                range: `Players!${String.fromCharCode(65 + roleCol)}${randomTarget.rowIndex}`,
                values: [['Mafia']]
            },
            { // Set Mafia's CanConvert ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canConvertCol)}${mafiaPlayerRowIndex}`,
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
            body: JSON.stringify({ message: `You have successfully converted a villager. ${randomTarget.name} is now one of you.` }),
        };

    } catch (error) {
        console.error('Error in convert-villager function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to convert villager.', details: error.message }),
        };
    }
};
