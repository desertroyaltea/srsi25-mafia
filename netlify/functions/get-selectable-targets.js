// netlify/functions/get-selectable-targets.js

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
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-selectable-targets: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const excludeSelfId = event.queryStringParameters.excludeSelfId;
    const includeAdmins = event.queryStringParameters.includeAdmins === 'true';

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:S', // Fetch up to IsAdmin column (S) for filtering
        });

        const allPlayersRawData = playersResponse.data.values || [];
        if (allPlayersRawData.length < 1) {
            return { statusCode: 200, body: JSON.stringify([]) };
        }

        const headers = allPlayersRawData[0];
        const playerRows = allPlayersRawData.slice(1);

        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name');
        const statusCol = headers.indexOf('Status');
        const isAdminCol = headers.indexOf('IsAdmin');

        if ([idCol, nameCol, statusCol, isAdminCol].includes(-1)) {
            console.error("get-selectable-targets: Required columns not found in Players sheet (PlayerID, Name, Status, IsAdmin).");
            throw new Error("Required columns not found in Players sheet.");
        }

        const selectableTargets = [];
        for (const row of playerRows) {
            const playerId = row[idCol] ? String(row[idCol]).trim() : '';
            const playerName = row[nameCol] ? String(row[nameCol]).trim() : '';
            const playerStatus = row[statusCol] ? String(row[statusCol]).trim() : '';
            const playerIsAdmin = row[isAdminCol] ? String(row[isAdminCol]).trim() : '';

            if (playerStatus.toLowerCase() !== 'alive') {
                continue;
            }
            if (!includeAdmins && playerIsAdmin === 'TRUE') {
                continue;
            }
            if (excludeSelfId && playerId === excludeSelfId) {
                continue;
            }

            if (playerId && playerName) {
                selectableTargets.push({ PlayerID: playerId, Name: playerName });
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(selectableTargets),
        };

    } catch (error) {
        console.error('get-selectable-targets: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch selectable targets.', details: error.message }),
        };
    } finally {
    }
};