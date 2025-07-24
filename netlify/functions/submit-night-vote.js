// netlify/functions/submit-night-vote.js

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
        const { voterPlayerId, targetPlayerId } = JSON.parse(event.body);
        if (!voterPlayerId || !targetPlayerId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing voterPlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Fetch Players and NightVotes data
        const [playersResponse, votesResponse] = await Promise.all([
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Players!A:X' }),
            sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'NightVotes!A:C' })
        ]);

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);
        const voteHeaders = votesResponse.data.values[0];
        const votes = votesResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const votePowerCol = playerHeaders.indexOf('CurrentVotingPower');
        const voteUsedCol = playerHeaders.indexOf('NightVoteUsed');

        // 2. Find the voter and verify they haven't voted
        let voterRowIndex = -1;
        let votingPower = 1;
        for (let i = 0; i < players.length; i++) {
            if (players[i][idCol] === voterPlayerId) {
                if (players[i][voteUsedCol] === 'TRUE') {
                    return { statusCode: 403, body: JSON.stringify({ error: 'You have already cast your night vote.' }) };
                }
                voterRowIndex = i + 2;
                votingPower = parseInt(players[i][votePowerCol] || 1);
                break;
            }
        }
        if (voterRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Voter not found.' }) };
        }

        // 3. Find the target in the NightVotes sheet and update their vote count
        const targetVoteIdCol = voteHeaders.indexOf('PlayerID');
        const votesCol = voteHeaders.indexOf('Votes');
        const targetVoteRowIndex = votes.findIndex(v => v[targetVoteIdCol] === targetPlayerId) + 2;

        if (targetVoteRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Vote target not found in NightVotes sheet.' }) };
        }
        
        const currentVotes = parseInt(votes[targetVoteRowIndex - 2][votesCol] || 0);
        const newVoteTotal = currentVotes + votingPower;

        // 4. Prepare batch update
        const requests = [
            { // Update the target's vote count
                range: `NightVotes!C${targetVoteRowIndex}`,
                values: [[newVoteTotal]]
            },
            { // Mark the voter as having used their vote
                range: `Players!X${voterRowIndex}`,
                values: [['TRUE']]
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
            body: JSON.stringify({ message: 'Your vote has been cast.' }),
        };

    } catch (error) {
        console.error('Error in submit-night-vote function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to submit vote.', details: error.message }),
        };
    }
};
