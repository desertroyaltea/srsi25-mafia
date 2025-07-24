// netlify/functions/revive-player.js

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
        const { doctorPlayerId } = JSON.parse(event.body);
        if (!doctorPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId.' }) };
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
        const nameCol = playerHeaders.indexOf('Name');
        const statusCol = playerHeaders.indexOf('Status');
        const canReviveCol = playerHeaders.indexOf('DoctorCanRevive');

        // 2. Find the Doctor and verify their ability
        let doctorPlayerRowIndex = -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === doctorPlayerId) {
                if (players[i][canReviveCol] !== 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to revive a player.' }) };
                }
                doctorPlayerRowIndex = i + 2; // 1-based index for sheet ranges
                break;
            }
        }

        if (doctorPlayerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Doctor player not found.' }) };
        }

        // 3. Find all eligible targets (Dead players)
        const eligibleTargets = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (player[statusCol] === 'Dead') {
                eligibleTargets.push({
                    rowIndex: i + 2, // 1-based index for sheet ranges
                    id: player[idCol],
                    name: player[nameCol]
                });
            }
        }

        if (eligibleTargets.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'There are no dead players to revive.' }) };
        }

        // 4. Select a random target
        const randomTarget = eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
        console.log(`Doctor ${doctorPlayerId} is reviving player ${randomTarget.id} (${randomTarget.name})`);

        // 5. Prepare batch update to revive player and remove Doctor's ability
        const requests = [
            { // Update target's status to Alive
                range: `Players!${String.fromCharCode(65 + statusCol)}${randomTarget.rowIndex}`,
                values: [['Alive']]
            },
            { // Set Doctor's CanRevive ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canReviveCol)}${doctorPlayerRowIndex}`,
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
            body: JSON.stringify({ message: `You have successfully revived a player! ${randomTarget.name} has returned to the game.` }),
        };

    } catch (error) {
        console.error('Error in revive-player function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to revive player.', details: error.message }),
        };
    }
};
