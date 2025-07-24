// netlify/functions/reveal-mafia.js

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
            range: 'Players!A:W', // Read up to RevealedTeammates
        });

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const nameCol = playerHeaders.indexOf('Name');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const canRevealCol = playerHeaders.indexOf('MafiaCanRevealSelf');
        const revealedCol = playerHeaders.indexOf('RevealedTeammates');

        // 2. Find the Mafia player, verify their ability, and get their current revealed list
        let mafiaPlayerRowIndex = -1;
        let alreadyRevealed = [];
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === mafiaPlayerId) {
                if (players[i][canRevealCol] !== 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to reveal a teammate.' }) };
                }
                mafiaPlayerRowIndex = i + 2; // 1-based index for sheet ranges
                if (players[i][revealedCol]) {
                    alreadyRevealed = players[i][revealedCol].split(',');
                }
                break;
            }
        }

        if (mafiaPlayerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found.' }) };
        }

        // 3. Find all eligible teammates (Alive, Mafia, not self, not already revealed)
        const eligibleTeammates = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const playerId = player[idCol];
            if (
                player[statusCol] === 'Alive' &&
                player[roleCol] === 'Mafia' &&
                playerId !== mafiaPlayerId &&
                !alreadyRevealed.includes(playerId)
            ) {
                eligibleTeammates.push({
                    id: playerId,
                    name: player[nameCol]
                });
            }
        }

        if (eligibleTeammates.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No new teammates to reveal.' }) };
        }

        // 4. Select a random teammate
        const randomTeammate = eligibleTeammates[Math.floor(Math.random() * eligibleTeammates.length)];
        console.log(`Mafia ${mafiaPlayerId} is revealing teammate ${randomTeammate.id} (${randomTeammate.name})`);

        // 5. Prepare batch update to add teammate to revealed list and remove ability
        const newRevealedList = [...alreadyRevealed, randomTeammate.id].join(',');

        const requests = [
            { // Update RevealedTeammates list
                range: `Players!${String.fromCharCode(65 + revealedCol)}${mafiaPlayerRowIndex}`,
                values: [[newRevealedList]]
            },
            { // Set MafiaCanRevealSelf ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canRevealCol)}${mafiaPlayerRowIndex}`,
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
            body: JSON.stringify({ message: `A fellow Mafia member has been revealed to you: ${randomTeammate.name}.` }),
        };

    } catch (error) {
        console.error('Error in reveal-mafia function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to reveal teammate.', details: error.message }),
        };
    }
};
