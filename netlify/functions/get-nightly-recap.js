// netlify/functions/get-nightly-recap.js

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
    console.log("get-nightly-recap: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-nightly-recap: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-nightly-recap: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    const dayNumber = event.queryStringParameters.dayNumber; // The day whose night events we want to recap
    if (!dayNumber) {
        console.log("get-nightly-recap: Missing dayNumber query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing dayNumber.' }) };
    }
    const targetDay = parseInt(dayNumber);
    if (isNaN(targetDay) || targetDay < 1) {
        console.log("get-nightly-recap: Invalid dayNumber query parameter.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid dayNumber.' }) };
    }
    console.log(`get-nightly-recap: Fetching recap for Day: ${targetDay}`);

    try {
        const sheets = await getSheetsService();

        const archiveResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Archive!A:F', // Assuming Archive columns A:F (Timestamp, Day, ActionType, Details, PlayerIDsInvolved, Outcome)
        });

        const allArchiveEntries = archiveResponse.data.values || [];
        if (allArchiveEntries.length < 2) {
            console.log("get-nightly-recap: Archive sheet is empty or has no data rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No archive data available.', recapData: null }),
            };
        }

        const headers = allArchiveEntries[0];
        const archiveRows = allArchiveEntries.slice(1);

        const dayCol = headers.indexOf('Day');
        const actionTypeCol = headers.indexOf('ActionType');
        const detailsCol = headers.indexOf('Details');
        const playerIDsInvolvedCol = headers.indexOf('PlayerIDsInvolved');
        const outcomeCol = headers.indexOf('Outcome');

        if ([dayCol, actionTypeCol, detailsCol, playerIDsInvolvedCol, outcomeCol].includes(-1)) {
            console.error("get-nightly-recap: Required columns not found in Archive sheet.");
            throw new Error("Required columns not found in Archive sheet (Day, ActionType, Details, PlayerIDsInvolved, Outcome).");
        }

        const recapEvents = {
            doctorProtections: [], // Array of player IDs protected
            mafiaKills: [],       // Array of player IDs killed by mafia
            mafiaProtected: [],   // Array of player IDs targeted by mafia but protected
            trialResults: [],     // Array of { accusedPlayerId, result }
            sheriffKills: [],     // Array of player IDs killed by sheriff
            sheriffProtected: []  // Array of player IDs targeted by sheriff but protected (though sheriff ignores protection)
        };

        for (const row of archiveRows) {
            if (parseInt(row[dayCol]) === targetDay) { // Match by day number
                const actionType = row[actionTypeCol];
                const details = row[detailsCol];
                const playerIDsInvolved = row[playerIDsInvolvedCol];
                const outcome = row[outcomeCol];

                switch (actionType) {
                    case 'Doctor Protection':
                        if (outcome === 'Success' && playerIDsInvolved) {
                            recapEvents.doctorProtections.push(...playerIDsInvolved.split(',').map(id => id.trim()));
                        }
                        break;
                    case 'Mafia Kill':
                        if (outcome === 'Killed' && playerIDsInvolved) {
                            recapEvents.mafiaKills.push(...playerIDsInvolved.split(',').map(id => id.trim()));
                        } else if (outcome === 'Protected' && playerIDsInvolved) {
                            recapEvents.mafiaProtected.push(...playerIDsInvolved.split(',').map(id => id.trim()));
                        }
                        break;
                    case 'Trial Result':
                        if (outcome === 'GUILTY' || outcome === 'NOT GUILTY') {
                            recapEvents.trialResults.push({
                                accusedPlayerId: playerIDsInvolved, // Should be the accused player ID
                                result: outcome
                            });
                        }
                        break;
                    case 'Sheriff Action':
                        if (outcome === 'Killed' && playerIDsInvolved) {
                            recapEvents.sheriffKills.push(...playerIDsInvolved.split(',').map(id => id.trim()));
                        }
                        // Sheriff ignores protection, so no 'sheriffProtected' outcome to track from archive.
                        break;
                    // Add other action types if you want them in the recap
                }
            }
        }
        console.log("get-nightly-recap: Generated recap events:", JSON.stringify(recapEvents));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Nightly recap data fetched successfully.', recapData: recapEvents }),
        };

    } catch (error) {
        console.error('get-nightly-recap: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch nightly recap data.', details: error.message }),
        };
    }
};