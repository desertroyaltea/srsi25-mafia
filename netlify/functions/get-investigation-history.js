// netlify/functions/get-investigation-history.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("get-investigation-history: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-investigation-history: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-investigation-history: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const playerId = event.queryStringParameters.playerId;
    if (!playerId) {
        console.log("get-investigation-history: Missing playerId query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId.' }) };
    }
    console.log(`get-investigation-history: Fetching history for player: ${playerId}`);

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure InvestigationHistory is found
        });

        const allPlayers = playersResponse.data.values || [];
        if (allPlayers.length < 2) {
            console.log("get-investigation-history: Players sheet is empty or has no data rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Players data not available.', history: '' }),
            };
        }

        const headers = allPlayers[0];
        const playerRows = allPlayers.slice(1);

        const idCol = headers.indexOf('PlayerID');
        const historyCol = headers.indexOf('InvestigationHistory');

        if (idCol === -1 || historyCol === -1) {
            console.error("get-investigation-history: Required columns 'PlayerID' or 'InvestigationHistory' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'InvestigationHistory' not found in Players sheet.");
        }

        let investigationHistory = '';
        for (const row of playerRows) {
            if (row[idCol] === playerId) {
                investigationHistory = row[historyCol] || '';
                break;
            }
        }
        console.log(`get-investigation-history: History found for ${playerId}: '${investigationHistory}'`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Investigation history fetched successfully.', history: investigationHistory }),
        };

    } catch (error) {
        console.error('get-investigation-history: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch investigation history.', details: error.message }),
        };
    }
};