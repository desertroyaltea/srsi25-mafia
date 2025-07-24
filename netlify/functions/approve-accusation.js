// netlify/functions/approve-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
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

    try {
        const { accusationId } = JSON.parse(event.body);
        if (!accusationId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accusationId.' }) };
        }

        const sheets = await getSheetsService();

        // 1. Get all data from the Accusations sheet to find the correct row
        const range = 'Accusations!A:F'; // Only need columns A through F
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

        // 2. Find the index for the ID column (A) and Status column (F)
        const idCol = headers.indexOf('AccusationID'); // Should be 0
        const statusCol = headers.indexOf('AdminApprovalStatus'); // Should be 5

        if (idCol === -1 || statusCol === -1) {
            throw new Error('Required columns (AccusationID, AdminApprovalStatus) not found in Accusations sheet.');
        }

        // 3. Find the specific row index for the accusation to update
        let rowIndexToUpdate = -1;
        for (let i = 0; i < accusationRows.length; i++) {
            if (accusationRows[i][idCol] === accusationId) {
                rowIndexToUpdate = i + 2; // +1 for slice, +1 for 1-based index of sheets
                break;
            }
        }

        if (rowIndexToUpdate === -1) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Accusation not found.' }) };
        }

        // 4. Update only the status cell (Column F)
        const updateRange = `Accusations!F${rowIndexToUpdate}`;
        
        console.log(`approve-accusation: Updating range ${updateRange} to 'Approved' for AccusationID ${accusationId}`);

        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [['Approved']],
            },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accusation has been approved.' }),
        };

    } catch (error) {
        console.error('Error approving accusation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to approve accusation.', details: error.message }),
        };
    }
};
