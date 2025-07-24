// netlify/functions/submit-jury-vote.js

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
        const { voterPlayerId, trialId, vote } = JSON.parse(event.body);
        if (!voterPlayerId || !trialId || !vote) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing voterPlayerId, trialId, or vote.' }) };
        }
        if (vote !== 'GUILTY' && vote !== 'NOTGUILTY') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid vote type.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Find the voter in the Players sheet and set their Jury status to FALSE
        const playersResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Players!A:Z' });
        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);
        const playerIdCol = playerHeaders.indexOf('PlayerID');
        const juryCol = playerHeaders.indexOf('IsJuryMember'); // Assuming this is the column name

        const playerRowIndex = players.findIndex(p => p[playerIdCol] === voterPlayerId) + 2; // +2 for 1-based index and header
        if (playerRowIndex > 1) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Players!${String.fromCharCode(65 + juryCol)}${playerRowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [['FALSE']] },
            });
        }

        // 2. Find the trial and increment the vote count
        const trialsResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Trials!A:Z' });
        const trialHeaders = trialsResponse.data.values[0];
        const trials = trialsResponse.data.values.slice(1);
        const trialIdCol = trialHeaders.indexOf('TrialID');
        const guiltyCol = trialHeaders.indexOf('GUILTY');
        const notGuiltyCol = trialHeaders.indexOf('NOTGUILTY');

        const trialRowIndex = trials.findIndex(t => t[trialIdCol] === trialId) + 2;
        if (trialRowIndex > 1) {
            const voteCol = vote === 'GUILTY' ? guiltyCol : notGuiltyCol;
            const currentVoteCount = parseInt(trials[trialRowIndex - 2][voteCol] || 0);
            
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Trials!${String.fromCharCode(65 + voteCol)}${trialRowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[currentVoteCount + 1]] },
            });
        } else {
            throw new Error(`Trial with ID ${trialId} not found.`);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Your vote has been cast successfully.' }),
        };

    } catch (error) {
        console.error('Error in submit-jury-vote function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to submit vote.', details: error.message }),
        };
    }
};
