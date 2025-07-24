// netlify/functions/approve-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Full access for writing
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("approve-accusation: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { accusationId } = JSON.parse(event.body);
        if (!accusationId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accusationId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Find the accusation in the sheet
        console.log(`approve-accusation: Searching for AccusationID ${accusationId}...`);
        const accusationsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Accusations!A:H',
        });

        const allAccusations = accusationsResponse.data.values || [];
        if (allAccusations.length < 2) throw new Error("Accusations sheet is empty or has no data.");

        const headers = allAccusations[0];
        const accusationRows = allAccusations.slice(1);

        const idCol = headers.indexOf('AccusationID');
        const statusCol = headers.indexOf('AdminApprovalStatus');
        const timeCol = headers.indexOf('AdminApprovalTime');
        const trialCol = headers.indexOf('TrialStarted');
        const accusedIdCol = headers.indexOf('AccusedPlayerID');
        const audioLinkCol = headers.indexOf('AudioDriveLink');

        if ([idCol, statusCol, timeCol, trialCol, accusedIdCol, audioLinkCol].includes(-1)) {
            throw new Error('One or more required columns not found in Accusations sheet.');
        }

        let rowIndexToUpdate = -1;
        let accusationData = null;

        for (let i = 0; i < accusationRows.length; i++) {
            if (accusationRows[i][idCol] === accusationId) {
                rowIndexToUpdate = i + 2; // +2 for 0-index and header row
                accusationData = accusationRows[i];
                break;
            }
        }

        if (rowIndexToUpdate === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Accusation not found.' }) };
        }
        console.log(`approve-accusation: Found accusation at row ${rowIndexToUpdate}.`);

        // 2. Modify the row data in memory
        accusationData[statusCol] = 'Approved';
        accusationData[timeCol] = new Date().toISOString();
        accusationData[trialCol] = 'TRUE';

        // 3. Update the entire row in the Accusations sheet
        const updateRange = `Accusations!A${rowIndexToUpdate}:H${rowIndexToUpdate}`;
        console.log(`approve-accusation: Updating Accusations sheet at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [accusationData], // Write the entire modified row back
            },
        });

        // 4. Update Game_State
        const accusedPlayerId = accusationData[accusedIdCol];
        const gameStateAccusedPlayerRange = 'Game_State!E2'; // Column E for LastAccusedPlayerID
        console.log(`approve-accusation: Updating Game_State at ${gameStateAccusedPlayerRange} with PlayerID ${accusedPlayerId}.`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: gameStateAccusedPlayerRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[accusedPlayerId]] },
        });

        // 5. Add new entry to Trials sheet
        const trialId = `TRL_${Date.now()}`;
        const trialValues = [
            trialId,
            accusedPlayerId,
            accusationData[audioLinkCol], // AccusationAudioLink
            new Date().toISOString(), // TrialStartTime
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // VotingDeadline (24 hours from now)
            'Active', // Status
            '' // Result
        ];
        console.log(`approve-accusation: Appending new trial ${trialId} to Trials sheet.`);
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Trials!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [trialValues] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accusation approved and trial initiated.', trialId: trialId }),
        };

    } catch (error) {
        console.error('Error approving accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to approve accusation.', details: error.message }),
        };
    }
};
