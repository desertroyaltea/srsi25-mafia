// netlify/functions/approve-accusation.js

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
        console.error("approve-accusation: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let accusationId, adminPlayerId;
    try {
        const body = JSON.parse(event.body);
        accusationId = body.accusationId;
        adminPlayerId = body.adminPlayerId;
    } catch (e) {
        console.error("approve-accusation: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!accusationId || !adminPlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing accusationId or adminPlayerId.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Validate Admin status of the approver
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:S', // Fetch up to IsAdmin column (S)
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("approve-accusation: Players sheet is empty for admin validation.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idColPlayers = playerHeaders.indexOf('PlayerID');
        const isAdminColPlayers = playerHeaders.indexOf('IsAdmin');

        if (idColPlayers === -1 || isAdminColPlayers === -1) {
            console.error("approve-accusation: Required columns 'PlayerID' or 'IsAdmin' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'IsAdmin' not found in Players sheet.");
        }

        let isAdmin = 'FALSE';
        for (const row of playerRows) {
            if (String(row[idColPlayers]).trim() === adminPlayerId) {
                isAdmin = String(row[isAdminColPlayers]).trim() || 'FALSE';
                break;
            }
        }

        if (isAdmin !== 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin players can approve accusations.' }) };
        }

        // 2. Find the accusation in the sheet
        const accusationsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Accusations!A:H',
        });

        const allAccusations = accusationsResponse.data.values || [];
        if (allAccusations.length < 2) throw new Error("Accusations sheet is empty or has no data.");

        const headers = allAccusations[0];
        const accusationRows = allAccusations.slice(1);

        const idCol = headers.indexOf('AccusationID');
        const accuserPlayerIdCol = headers.indexOf('AccuserPlayerID');
        const accusedPlayerIdCol = headers.indexOf('AccusedPlayerID');
        const audioLinkCol = headers.indexOf('AudioDriveLink');
        const statusCol = headers.indexOf('AdminApprovalStatus');
        const timeCol = headers.indexOf('AdminApprovalTime');
        const trialCol = headers.indexOf('TrialStarted');

        if ([idCol, accuserPlayerIdCol, accusedPlayerIdCol, audioLinkCol, statusCol, timeCol, trialCol].includes(-1)) {
            throw new Error('One or more required columns not found in Accusations sheet.');
        }

        let rowIndexToUpdate = -1;
        let accusationData = null;

        for (let i = 0; i < accusationRows.length; i++) {
            if (String(accusationRows[i][idCol]).trim() === accusationId) {
                rowIndexToUpdate = i + 2;
                accusationData = accusationRows[i];
                break;
            }
        }

        if (rowIndexToUpdate === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Accusation not found.' }) };
        }

        // 3. Modify the row data in memory before writing back
        accusationData[statusCol] = 'Approved';
        accusationData[timeCol] = new Date().toISOString();
        accusationData[trialCol] = 'TRUE';

        // 4. Update the entire row in the Accusations sheet
        const updateRange = `Accusations!A${rowIndexToUpdate}:H${rowIndexToUpdate}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [accusationData] },
        });

        // 5. Update Game_State with the ID of the accused player (numeric)
        const accusedPlayerId = String(accusationData[accusedPlayerIdCol]).trim();
        const gameStateAccusedPlayerRange = 'Game_State!E2';
        const gameStateLastTrialResultRange = 'Game_State!F2';
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: gameStateAccusedPlayerRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[accusedPlayerId]] },
        });
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: gameStateLastTrialResultRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['N/A']] },
        });

        // 6. Add a new entry to the Trials sheet
        const trialId = `TRL_${Date.now()}`;
        const trialValues = [
            trialId,
            accusedPlayerId,
            String(accusationData[audioLinkCol]).trim(),
            new Date().toISOString(),
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            'Active',
            ''
        ];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Trials!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [trialValues] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accusation approved and trial initiated.', trialId: trialId }),
        };

    } catch (error) {
        console.error('approve-accusation: Error approving accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to approve accusation.', details: error.message }),
        };
    } finally {
    }
};