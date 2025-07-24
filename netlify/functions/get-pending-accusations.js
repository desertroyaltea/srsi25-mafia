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
            console.error('Configuration Error: Google Sheet ID is not configured.');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error: Google Sheet ID missing.' }),
            };
        }

        const range = 'Accusations!A:H'; // Reads columns A to H from the Accusations sheet

        console.log(`Attempting to fetch data from Sheet ID: ${sheetId}, Range: ${range}`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        const values = response.data.values;
        console.log('Raw values from sheet:', values);

        if (!values || values.length <= 1) { // Check for headers + at least one data row
            console.log('No accusation data or only headers found. Returning empty array.');
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
        const accusationIdIndex = headers.indexOf('AccusationID'); // Ensure these are found for mapping
        const accuserPlayerIdIndex = headers.indexOf('AccuserPlayerID');
        const accusedPlayerIdIndex = headers.indexOf('AccusedPlayerID');
        const audioDriveLinkIndex = headers.indexOf('AudioDriveLink');
        const submissionTimeIndex = headers.indexOf('SubmissionTime');


        if (statusIndex === -1 || accusationIdIndex === -1 || accuserPlayerIdIndex === -1 || accusedPlayerIdIndex === -1 || audioDriveLinkIndex === -1 || submissionTimeIndex === -1) {
            console.error('Sheet Header Error: One or more required headers not found in Accusations sheet.', { headers });
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Required header columns not found in Accusations sheet. Please check column names.' }),
            };
        }

        const pendingAccusations = accusationRows.filter(row => {
            // Ensure the row has enough columns and the status column exists
            return row.length > statusIndex && row[statusIndex] === 'Pending';
        }).map(row => {
            const accusation = {};
            // Map only the necessary fields for the transcript
            accusation.AccusationID = row[accusationIdIndex];
            accusation.AccuserPlayerID = row[accuserPlayerIdIndex];
            accusation.AccusedPlayerID = row[accusedPlayerIdIndex];
            accusation.AudioDriveLink = row[audioDriveLinkIndex];
            accusation.SubmissionTime = row[submissionTimeIndex];
            // Add other fields if needed by the frontend, but keep it minimal
            return accusation;
        });

        console.log('Filtered pending accusations:', pendingAccusations);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(pendingAccusations),
        };

    } catch (error) {
        console.error('Server Error: Failed to fetch pending accusations:', error);
        // Provide more specific error details if available
        let errorMessage = 'Failed to fetch pending accusations.';
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `Google API Error: ${error.response.data.error.message || error.message}`;
            console.error('Google API Error Details:', error.response.data.error);
        } else if (error.message) {
            errorMessage = `Internal Server Error: ${error.message}`;
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};
