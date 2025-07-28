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
    console.log("submit-jury-vote: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("submit-jury-vote: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("submit-jury-vote: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`submit-jury-vote: Sheet ID: ${sheetId}`);

    try {
        const { voterPlayerId, trialId, voteType, votingPower } = JSON.parse(event.body);
        console.log(`submit-jury-vote: Received vote - Voter: ${voterPlayerId}, Trial: ${trialId}, Type: ${voteType}, Power: ${votingPower}`);

        if (!voterPlayerId || !trialId || !voteType || votingPower === undefined) {
            console.log("submit-jury-vote: Missing required vote parameters.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing voterPlayerId, trialId, voteType, or votingPower.' }) };
        }
        if (voteType !== 'GUILTY' && voteType !== 'NOTGUILTY') {
            console.log("submit-jury-vote: Invalid voteType.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid voteType. Must be GUILTY or NOTGUILTY.' }) };
        }
        const parsedVotingPower = parseInt(votingPower);
        if (isNaN(parsedVotingPower) || parsedVotingPower <= 0) {
            console.log("submit-jury-vote: Invalid votingPower.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid votingPower. Must be a positive number.' }) };
        }
        console.log(`submit-jury-vote: Parsed voting power: ${parsedVotingPower}`);

        const sheets = await getSheetsService();
        console.log("submit-jury-vote: Sheets service initialized.");

        // 1. Fetch player data to validate voter status (alive, not admin)
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:S', // Fetch up to IsAdmin column (S)
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("submit-jury-vote: Players sheet is empty for voter validation.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idColPlayers = playerHeaders.indexOf('PlayerID');
        const statusColPlayers = playerHeaders.indexOf('Status');
        const isAdminColPlayers = playerHeaders.indexOf('IsAdmin');

        if ([idColPlayers, statusColPlayers, isAdminColPlayers].includes(-1)) {
            console.error("submit-jury-vote: Required columns 'PlayerID', 'Status', or 'IsAdmin' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID', 'Status', or 'IsAdmin' not found in Players sheet.");
        }

        let voterStatus = '';
        let voterIsAdmin = 'FALSE';
        for (const row of playerRows) {
            if (row[idColPlayers] === voterPlayerId) {
                voterStatus = row[statusColPlayers] || '';
                voterIsAdmin = row[isAdminColPlayers] || 'FALSE';
                break;
            }
        }
        console.log(`submit-jury-vote: Voter ${voterPlayerId} Status: ${voterStatus}, IsAdmin: ${voterIsAdmin}`);

        if (voterStatus.toLowerCase() !== 'alive') {
            console.log("submit-jury-vote: Voter is not alive.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only alive players can vote.' }) };
        }
        if (voterIsAdmin === 'TRUE') {
            console.log("submit-jury-vote: Admin player cannot vote.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot vote in trials.' }) };
        }


        // 2. Find the trial and increment the vote count
        console.log("submit-jury-vote: Fetching all trials from 'Trials!A:Z'.");
        const trialsResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Trials!A:Z' });
        const trialHeaders = trialsResponse.data.values[0];
        const trials = trialsResponse.data.values.slice(1);
        console.log("submit-jury-vote: Trial Headers:", trialHeaders);
        console.log(`submit-jury-vote: Processing ${trials.length} trial data rows.`);

        const trialIdCol = trialHeaders.indexOf('TrialID');
        const guiltyCol = trialHeaders.indexOf('GUILTY');
        const notGuiltyCol = trialHeaders.indexOf('NOTGUILTY');

        if ([trialIdCol, guiltyCol, notGuiltyCol].includes(-1)) {
            throw new Error('One or more required columns (TrialID, GUILTY, NOTGUILTY) not found in Trials sheet.');
        }

        const trialRowIndex = trials.findIndex(t => t[trialIdCol] === trialId) + 2;
        console.log(`submit-jury-vote: Found trial at row index ${trialRowIndex} for TrialID ${trialId}.`);

        if (trialRowIndex > 1) {
            const voteCol = voteType === 'GUILTY' ? guiltyCol : notGuiltyCol;
            const currentVoteCount = parseInt(trials[trialRowIndex - 2][voteCol] || 0);
            const newVoteCount = currentVoteCount + parsedVotingPower;

            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Trials!${String.fromCharCode(65 + voteCol)}${trialRowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[newVoteCount]] },
            });
            console.log(`submit-jury-vote: Trial ${trialId} ${voteType} count updated by ${parsedVotingPower}. New count: ${newVoteCount}`);
        } else {
            console.log(`submit-jury-vote: Trial with ID ${trialId} not found or index invalid.`);
            throw new Error(`Trial with ID ${trialId} not found.`);
        }

        // --- Record individual vote in Trial_Votes sheet ---
        console.log("submit-jury-vote: Appending vote to Trial_Votes sheet.");
        const voteId = `VOTE_${Date.now()}_${voterPlayerId}`;
        const voteTimestamp = new Date().toISOString();
        const voteValues = [
            voteId,
            trialId,
            voterPlayerId,
            voteType,
            parsedVotingPower,
            voteTimestamp
        ];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Trial_Votes!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [voteValues] },
        });
        console.log(`submit-jury-vote: Vote ${voteId} appended to Trial_Votes sheet.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Your vote has been cast successfully.' }),
        };

    } catch (error) {
        console.error('submit-jury-vote: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to submit vote.', details: error.message }),
        };
    } finally {
        console.log("submit-jury-vote: Function finished.");
    }
};