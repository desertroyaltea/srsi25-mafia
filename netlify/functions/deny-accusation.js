// netlify/functions/deny-accusation.js

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
        console.error("deny-accusation: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const { accusationId } = JSON.parse(event.body);
        if (!accusationId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accusationId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Get all data from the Accusations sheet to find the correct row
        const range = 'Accusations!A:H';
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const allRows = response.data.values || [];
        if (allRows.length < 2) {
            throw new Error("Accusations sheet is empty or has no data.");
        }

        const headers = allRows[0];
        const accusationRows = allRows.slice(1);

        const idCol = headers.indexOf('AccusationID');
        const statusCol = headers.indexOf('AdminApprovalStatus');
        const timeCol = headers.indexOf('AdminApprovalTime');
        
        if (idCol === -1 || statusCol === -1 || timeCol === -1) {
            throw new Error('Required columns (AccusationID, AdminApprovalStatus, AdminApprovalTime) not found in Accusations sheet.');
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
        console.log(`deny-accusation: Found accusation at row ${rowIndexToUpdate}.`);

        // 2. Modify the row data in memory
        accusationData[statusCol] = 'Rejected';
        accusationData[timeCol] = new Date().toISOString();

        // 3. Update the entire row in the Accusations sheet
        const updateRange = `Accusations!A${rowIndexToUpdate}:H${rowIndexToUpdate}`;
        console.log(`deny-accusation: Updating Accusations sheet at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [accusationData], // Write the entire modified row back
            },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accusation has been rejected.' }),
        };

    } catch (error) {
        console.error('Error denying accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to deny accusation.', details: error.message }),
        };
    }
};
