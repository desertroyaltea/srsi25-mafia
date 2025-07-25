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
        // CRITICAL CHANGE: Receive voteType and votingPower
        const { voterPlayerId, trialId, voteType, votingPower } = JSON.parse(event.body);

        if (!voterPlayerId || !trialId || !voteType || votingPower === undefined) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing voterPlayerId, trialId, voteType, or votingPower.' }) };
        }
        if (voteType !== 'GUILTY' && voteType !== 'NOTGUILTY') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid voteType. Must be GUILTY or NOTGUILTY.' }) };
        }
        const parsedVotingPower = parseInt(votingPower);
        if (isNaN(parsedVotingPower) || parsedVotingPower <= 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid votingPower. Must be a positive number.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Find the voter in the Players sheet and set their Jury status to FALSE
        // This logic is for when a player is *done* voting for the current trial.
        // If they need to vote on *multiple* trials, setting IsJuryMember to FALSE here
        // would prevent them from voting on subsequent trials.
        // Let's keep it for now as it was, but note this might need adjustment if IsJuryMember
        // is meant to control eligibility for *all* trials in a phase.
const playersResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Players!A:Z' });
        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);
        const playerIdCol = playerHeaders.indexOf('PlayerID');
        const juryCol = playerHeaders.indexOf('IsJuryMember'); // Assuming this is the column name

        const playerRowIndex = players.findIndex(p => p[playerIdCol] === voterPlayerId) + 2; // +2 for 1-based index and header
        if (playerRowIndex > 1 && juryCol !== -1) { // Ensure juryCol exists
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Players!${String.fromCharCode(65 + juryCol)}${playerRowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [['FALSE']] }, // Set to FALSE after voting
            });
            console.log(`submit-jury-vote: Player ${voterPlayerId} IsJuryMember set to FALSE.`);
        } else if (juryCol === -1) {
            console.warn("submit-jury-vote: 'IsJuryMember' column not found in Players sheet. Skipping update.");
        }



        // 2. Find the trial and increment the vote count
        const trialsResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Trials!A:Z' });
        const trialHeaders = trialsResponse.data.values[0];
        const trials = trialsResponse.data.values.slice(1);
        const trialIdCol = trialHeaders.indexOf('TrialID');
        const guiltyCol = trialHeaders.indexOf('GUILTY');
        const notGuiltyCol = trialHeaders.indexOf('NOTGUILTY'); // This should be column 8 (I) if hardcoded in get-current-trial

        // Ensure columns exist
        if ([trialIdCol, guiltyCol, notGuiltyCol].includes(-1)) {
            throw new Error('One or more required columns (TrialID, GUILTY, NOTGUILTY) not found in Trials sheet.');
        }

        const trialRowIndex = trials.findIndex(t => t[trialIdCol] === trialId) + 2;
        if (trialRowIndex > 1) {
            const voteCol = voteType === 'GUILTY' ? guiltyCol : notGuiltyCol;
            // CRITICAL CHANGE: Use parsedVotingPower
            const currentVoteCount = parseInt(trials[trialRowIndex - 2][voteCol] || 0); // Get existing value
            const newVoteCount = currentVoteCount + parsedVotingPower; // Add voting power

            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Trials!${String.fromCharCode(65 + voteCol)}${trialRowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[newVoteCount]] }, // Update with new sum
            });
            console.log(`submit-jury-vote: Trial ${trialId} ${voteType} count updated by ${parsedVotingPower}. New count: ${newVoteCount}`);
        } else {
            throw new Error(`Trial with ID ${trialId} not found.`);
        }

        // --- NEW: Record individual vote in Trial_Votes sheet ---
        const voteId = `VOTE_${Date.now()}_${voterPlayerId}`;
        const voteTimestamp = new Date().toISOString();
        const voteValues = [
            voteId,
            trialId,
            voterPlayerId,
            voteType,
            parsedVotingPower, // Use parsedVotingPower here
            voteTimestamp
        ];
        console.log(`submit-jury-vote: Appending new vote ${voteId} to Trial_Votes sheet.`);
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Trial_Votes!A:F', // Assuming your Trial_Votes sheet has columns A to F
            valueInputOption: 'USER_ENTERED',
            resource: { values: [voteValues] },
        });
        // --- END NEW: Record individual vote ---

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