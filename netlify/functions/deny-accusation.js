// netlify/functions/deny-accusation.js

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
    console.log("deny-accusation: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("deny-accusation: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("deny-accusation: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`deny-accusation: Sheet ID: ${sheetId}`);

    try {
        const { accusationId, adminPlayerId } = JSON.parse(event.body); // Receive adminPlayerId
        console.log(`deny-accusation: Received - Accusation ID: ${accusationId}, Admin Player ID: ${adminPlayerId}`);
        if (!accusationId || !adminPlayerId) {
            console.log("deny-accusation: Missing accusationId or adminPlayerId.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accusationId or adminPlayerId.' }) };
        }

        const sheets = await getSheetsService();
        console.log("deny-accusation: Sheets service initialized.");

        // 1. Validate Admin status of the denier
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:S', // Fetch up to IsAdmin column (S)
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("deny-accusation: Players sheet is empty for admin validation.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idColPlayers = playerHeaders.indexOf('PlayerID');
        const isAdminColPlayers = playerHeaders.indexOf('IsAdmin');

        if (idColPlayers === -1 || isAdminColPlayers === -1) {
            console.error("deny-accusation: Required columns 'PlayerID' or 'IsAdmin' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'IsAdmin' not found in Players sheet.");
        }

        let isAdmin = 'FALSE';
        for (const row of playerRows) {
            if (row[idColPlayers] === adminPlayerId) {
                isAdmin = row[isAdminColPlayers] || 'FALSE';
                break;
            }
        }
        console.log(`deny-accusation: Denier ${adminPlayerId} IsAdmin status: ${isAdmin}`);

        if (isAdmin !== 'TRUE') {
            console.log("deny-accusation: Player is not an Admin.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin players can deny accusations.' }) };
        }

        // 2. Find the accusation in the sheet
        console.log(`deny-accusation: Searching for AccusationID ${accusationId}...`);
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

        if ([idCol, statusCol, timeCol].includes(-1)) {
            throw new Error('One or more required columns not found in Accusations sheet.');
        }

        let rowIndexToUpdate = -1;
        let accusationData = null;

        for (let i = 0; i < accusationRows.length; i++) {
            if (accusationRows[i][idCol] === accusationId) {
                rowIndexToUpdate = i + 2;
                accusationData = accusationRows[i];
                break;
            }
        }

        if (rowIndexToUpdate === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Accusation not found.' }) };
        }
        console.log(`deny-accusation: Found accusation at row ${rowIndexToUpdate}.`);

        // 3. Modify the row data in memory before writing back
        accusationData[statusCol] = 'Denied';
        accusationData[timeCol] = new Date().toISOString();

        // 4. Update the entire row in the Accusations sheet
        const updateRange = `Accusations!A${rowIndexToUpdate}:H${rowIndexToUpdate}`;
        console.log(`deny-accusation: Updating Accusations sheet at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [accusationData] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accusation denied successfully.' }),
        };

    } catch (error) {
        console.error('deny-accusation: Error denying accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to deny accusation.', details: error.message }),
        };
    } finally {
        console.log("deny-accusation: Function finished.");
    }
};