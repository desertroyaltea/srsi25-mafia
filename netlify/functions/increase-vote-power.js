// netlify/functions/increase-vote-power.js

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
        const { villagerPlayerId } = JSON.parse(event.body);
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
        const votePowerCol = playerHeaders.indexOf('CurrentVotingPower');
        const canIncreaseVoteCol = playerHeaders.indexOf('VillagerCanIncreaseVote');

        // 2. Find the Villager and verify their ability
        let playerRowIndex = -1;
        let currentVotePower = 0;
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === villagerPlayerId) {
                if (players[i][canIncreaseVoteCol] !== 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to increase your vote power.' }) };
                }
                playerRowIndex = i + 2; // 1-based index for sheet ranges
                currentVotePower = parseInt(players[i][votePowerCol] || 1);
                break;
            }
        }

        if (playerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }

        // 3. Prepare batch update to increase vote power and remove ability
        const newVotePower = currentVotePower + 1;

        const requests = [
            { // Update CurrentVotingPower
                range: `Players!${String.fromCharCode(65 + votePowerCol)}${playerRowIndex}`,
                values: [[newVotePower]]
            },
            { // Set VillagerCanIncreaseVote ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canIncreaseVoteCol)}${playerRowIndex}`,
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

        console.log(`Villager ${villagerPlayerId} increased their vote power to ${newVotePower}.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Your voting power has been increased to ${newVotePower}!` }),
        };

    } catch (error) {
        console.error('Error in increase-vote-power function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to increase vote power.', details: error.message }),
        };
    }
};
