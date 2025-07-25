// netlify/functions/get-user-trial-votes.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("get-user-trial-votes: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-user-trial-votes: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-user-trial-votes: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const voterPlayerId = event.queryStringParameters.voterPlayerId;
    if (!voterPlayerId) {
        console.log("get-user-trial-votes: Missing voterPlayerId query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing voterPlayerId.' }) };
    }
    console.log(`get-user-trial-votes: Fetching votes for player: ${voterPlayerId}`);

    try {
        const sheets = await getSheetsService();

        const votesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Trial_Votes!A:F', // Assuming your Trial_Votes sheet has columns A to F
        });

        const allVotes = votesResponse.data.values || [];
        if (allVotes.length < 2) {
            console.log("get-user-trial-votes: Trial_Votes sheet is empty or has no data rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No votes data available.', userVotes: [] }),
            };
        }

        const headers = allVotes[0];
        const voteRows = allVotes.slice(1);

        const voterPlayerIdCol = headers.indexOf('VoterPlayerID');
        const trialIdCol = headers.indexOf('TrialID');

        if (voterPlayerIdCol === -1 || trialIdCol === -1) {
            console.error("get-user-trial-votes: Required columns 'VoterPlayerID' or 'TrialID' not found in Trial_Votes sheet.");
            throw new Error("Required columns 'VoterPlayerID' or 'TrialID' not found in Trial_Votes sheet.");
        }

        const userVotes = [];
        for (const row of voteRows) {
            if (row[voterPlayerIdCol] === voterPlayerId) {
                userVotes.push({
                    VoteID: row[headers.indexOf('VoteID')],
                    TrialID: row[trialIdCol],
                    VoteType: row[headers.indexOf('VoteType')],
                    VotingPower: parseInt(row[headers.indexOf('VotingPower')] || '0'),
                    Timestamp: row[headers.indexOf('Timestamp')]
                });
            }
        }
        console.log(`get-user-trial-votes: Found ${userVotes.length} votes for ${voterPlayerId}.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'User votes fetched successfully.', userVotes: userVotes }),
        };

    } catch (error) {
        console.error('get-user-trial-votes: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch user votes.', details: error.message }),
        };
    }
};