// netlify/functions/approve-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;

const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Full sheets access for writing
});

const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!sheetId) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Google Sheet ID is not configured.' }),
        };
    }

    const { accusationId, adminPlayerId } = JSON.parse(event.body);

    if (!accusationId || !adminPlayerId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing accusationId or adminPlayerId.' }),
        };
    }

    try {
        // 1. Find the accusation in the sheet
        const accusationsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Accusations!A:H', // Read all columns to find the accusation
        });

        const allAccusations = accusationsResponse.data.values || [];
        const headers = allAccusations[0];
        const accusationRows = allAccusations.slice(1);

        const accusationIndex = headers.indexOf('AccusationID');
        const statusIndex = headers.indexOf('AdminApprovalStatus');
        const adminTimeIndex = headers.indexOf('AdminApprovalTime');
        const trialStartedIndex = headers.indexOf('TrialStarted');
        const accusedPlayerIdIndex = headers.indexOf('AccusedPlayerID'); // Needed to update Game_State
        const audioDriveLinkIndex = headers.indexOf('AudioDriveLink'); // Needed to update Trials

        if (accusationIndex === -1 || statusIndex === -1 || adminTimeIndex === -1 || trialStartedIndex === -1 || accusedPlayerIdIndex === -1 || audioDriveLinkIndex === -1) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Required header columns not found in Accusations sheet.' }),
            };
        }

        let rowIndexToUpdate = -1;
        let accusedPlayerId = '';
        let accusationAudioLink = '';

        for (let i = 0; i < accusationRows.length; i++) {
            if (accusationRows[i][accusationIndex] === accusationId) {
                rowIndexToUpdate = i + 2; // +2 because 0-indexed array, and +1 for headers
                accusedPlayerId = accusationRows[i][accusedPlayerIdIndex];
                accusationAudioLink = accusationRows[i][audioDriveLinkIndex];
                break;
            }
        }

        if (rowIndexToUpdate === -1) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Accusation not found.' }),
            };
        }

        // 2. Update Accusations sheet status to 'Approved' and set TrialStarted to 'TRUE'
        const updateRange = `Accusations!F${rowIndexToUpdate}:H${rowIndexToUpdate}`; // Columns F,G,H for status, time, trialStarted
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [['Approved', new Date().toISOString(), 'TRUE']],
            },
        });

        // 3. Update Game_State to indicate a trial is starting
        // Assuming Game_State data is in the second row (A2:G2)
        const gameStateAccusedPlayerRange = 'Game_State!D2'; // Column D for LastAccusedPlayerID
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: gameStateAccusedPlayerRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[accusedPlayerId]],
            },
        });

        // 4. Add new entry to Trials sheet
        // TrialID,AccusedPlayerID,AccusationAudioLink,TrialStartTime,VotingDeadline,Status,Result
        const trialId = `TRL_${Date.now()}`;
        const trialStartTime = new Date().toISOString();
        const votingDeadline = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // Example: 1 hour from now

        const trialValues = [
            trialId,
            accusedPlayerId,
            accusationAudioLink,
            trialStartTime,
            votingDeadline,
            'Active',
            '' // Result
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Trials!A:G', // Adjust range if your sheet columns change
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [trialValues],
            },
        });


        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Accusation approved and trial initiated.',
                trialId: trialId
            }),
        };

    } catch (error) {
        console.error('Error approving accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to approve accusation', details: error.message }),
        };
    }
};
