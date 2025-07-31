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
        console.error("submit-jury-vote: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let voterPlayerId, trialId, voteType, votingPower, sessionId; // NEW: Receive sessionId
    try {
        const body = JSON.parse(event.body);
        voterPlayerId = body.voterPlayerId;
        trialId = body.trialId;
        voteType = body.voteType;
        votingPower = body.votingPower;
        sessionId = body.sessionId; // NEW: Get sessionId
    } catch (e) {
        console.error("submit-jury-vote: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!voterPlayerId || !trialId || !voteType || votingPower === undefined || !sessionId) { // NEW: Validate sessionId
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters.' }) };
    }
    if (voteType !== 'GUILTY' && voteType !== 'NOTGUILTY') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid voteType. Must be GUILTY or NOTGUILTY.' }) };
    }
    const parsedVotingPower = parseInt(votingPower);
    if (isNaN(parsedVotingPower) || parsedVotingPower <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid votingPower. Must be a positive number.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // CRITICAL FIX: Session Authorization
        const authResponse = await fetch('https://' + event.headers.host + '/.netlify/functions/authorize-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
        });
        const authResult = await authResponse.json();

        if (!authResponse.ok || authResult.authorizedPlayerId !== voterPlayerId) { // Check if session ID matches player ID
            console.warn(`submit-jury-vote: Unauthorized attempt by ${authResult.authorizedPlayerId || 'Unknown'} to act as ${voterPlayerId}. Session: ${sessionId}`);
            return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized action. Session mismatch.' }) };
        }
        // If we reach here, voterPlayerId is confirmed to be the authenticated user.


        // 1. Fetch player data to validate voter status (alive, not admin)
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:S',
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty for voter validation.' }) };
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
            if (String(row[idColPlayers]).trim() === voterPlayerId) {
                voterStatus = String(row[statusColPlayers]).trim() || '';
                voterIsAdmin = String(row[isAdminColPlayers]).trim() || 'FALSE';
                break;
            }
        }

        if (voterStatus.toLowerCase() !== 'alive') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only alive players can vote.' }) };
        }
        if (voterIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot vote in trials.' }) };
        }


        // 2. Find the trial and increment the vote count
        const trialsResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Trials!A:I' });
        const trialHeaders = trialsResponse.data.values[0];
        const trials = trialsResponse.data.values.slice(1);

        const trialIdCol = trialHeaders.indexOf('TrialID');
        const guiltyCol = trialHeaders.indexOf('GUILTY');
        const notGuiltyCol = trialHeaders.indexOf('NOTGUILTY');

        if ([trialIdCol, guiltyCol, notGuiltyCol].includes(-1)) {
            throw new Error('One or more required columns (TrialID, GUILTY, NOTGUILTY) not found in Trials sheet.');
        }

        const trialRowIndex = trials.findIndex(t => String(t[trialIdCol]).trim() === trialId) + 2;
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
        } else {
            throw new Error(`Trial with ID ${trialId} not found.`);
        }

        // --- Record individual vote in Trial_Votes sheet ---
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
    }
};