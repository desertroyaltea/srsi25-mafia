// netlify/functions/get-pending-accusations.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;

const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only access to sheets
});

const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    try {
        if (!sheetId) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Google Sheet ID is not configured.' }),
            };
        }

        const range = 'Accusations!A:H'; // Reads columns A to H from the Accusations sheet

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;

        if (!values || values.length <= 1) { // Check for headers + at least one data row
            return {
                statusCode: 200, // Return 200 with empty array if no data
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
                body: JSON.stringify([]), // No pending accusations
            };
        }

        const headers = values[0];
        const accusationRows = values.slice(1);

        const statusIndex = headers.indexOf('AdminApprovalStatus');

        if (statusIndex === -1) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Required header "AdminApprovalStatus" not found in Accusations sheet.' }),
            };
        }

        const pendingAccusations = accusationRows.filter(row => {
            return row[statusIndex] === 'Pending';
        }).map(row => {
            const accusation = {};
            headers.forEach((header, index) => {
                const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
                accusation[cleanHeader] = row[index];
            });
            return accusation;
        });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(pendingAccusations),
        };

    } catch (error) {
        console.error('Error fetching pending accusations:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch pending accusations', details: error.message }),
        };
    }
};
