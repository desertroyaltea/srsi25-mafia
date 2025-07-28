// netlify/functions/protect-player.js

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
    console.log("protect-player: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("protect-player: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("protect-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`protect-player: Sheet ID: ${sheetId}`);

    try {
        const { doctorPlayerId, targetPlayerId1, targetPlayerId2, doctorCanSaveMoreUsed } = JSON.parse(event.body);
        // CRITICAL FIX: Log targetPlayerId1 and targetPlayerId2 correctly
        console.log(`protect-player: Received - Doctor: ${doctorPlayerId}, Target 1: ${targetPlayerId1}, Target 2: ${targetPlayerId2 || 'N/A'}, CanSaveMoreUsed: ${doctorCanSaveMoreUsed}`);
        
        if (!doctorPlayerId || !targetPlayerId1 || (doctorCanSaveMoreUsed && !targetPlayerId2)) {
            console.log("protect-player: Missing doctorPlayerId or targetPlayerId(s).");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId or targetPlayerId(s).' }) };
        }

        const sheets = await getSheetsService();
        console.log("protect-player: Sheets service initialized.");

        // 1. Check if the player has already used their action and get ability status
        console.log("protect-player: Fetching Players sheet for action usage check and ability status.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'MainUsed' and 'DoctorCanSaveMore' are found
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("protect-player: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);
        const idCol = playerHeaders.indexOf('PlayerID');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const doctorCanSaveMoreCol = playerHeaders.indexOf('DoctorCanSaveMore');

        console.log(`protect-player: PlayerID column index: ${idCol}, MainUsed column index: ${mainUsedCol}, DoctorCanSaveMore index: ${doctorCanSaveMoreCol}`);

        if (idCol === -1 || mainUsedCol === -1 || doctorCanSaveMoreCol === -1) {
            console.error("protect-player: Required columns 'PlayerID', 'MainUsed', or 'DoctorCanSaveMore' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID', 'MainUsed', or 'DoctorCanSaveMore' not found in Players sheet.");
        }

        let doctorPlayerRowIndex = -1;
        let doctorMainUsedStatus = 'FALSE';
        let doctorCanSaveMoreStatus = 'FALSE';
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === doctorPlayerId) {
                doctorPlayerRowIndex = i + 2;
                doctorMainUsedStatus = playerRows[i][mainUsedCol] || 'FALSE';
                doctorCanSaveMoreStatus = playerRows[i][doctorCanSaveMoreCol] || 'FALSE'; // Get actual status
                break;
            }
        }
        console.log(`protect-player: Doctor ${doctorPlayerId} found at row ${doctorPlayerRowIndex}. MainUsed status: ${doctorMainUsedStatus}, DoctorCanSaveMore status: ${doctorCanSaveMoreStatus}`);

        if (doctorPlayerRowIndex === -1) {
            console.log("protect-player: Doctor player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Doctor player not found.' }) };
        }
        if (doctorMainUsedStatus === 'TRUE') {
            console.log("protect-player: Doctor has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        // Frontend should handle this check, but backend can double-check for robustness
        if (doctorCanSaveMoreUsed && doctorCanSaveMoreStatus !== 'TRUE') {
            console.log("protect-player: Doctor tried to save more but does not have the ability.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to save more players.' }) };
        }


        // 2. Get current day
        console.log("protect-player: Fetching current day from Game_State sheet.");
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`protect-player: Current Day: ${currentDay}`);

        // 3. Log the action(s)
        const timestamp = new Date().toISOString();
        const actionsToLog = [];

        actionsToLog.push([`ACT_PROTECT_${Date.now()}_1`, currentDay, doctorPlayerId, targetPlayerId1, timestamp, null, 'Logged']);
        console.log(`protect-player: Appending action for Target 1 (${targetPlayerId1}) to Actions_Doctor sheet.`);

        if (doctorCanSaveMoreUsed && targetPlayerId2) {
            actionsToLog.push([`ACT_PROTECT_${Date.now()}_2`, currentDay, doctorPlayerId, targetPlayerId2, timestamp, null, 'Logged']);
            console.log(`protect-player: Appending action for Target 2 (${targetPlayerId2}) to Actions_Doctor sheet.`);
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Doctor!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: actionsToLog },
        });
        console.log("protect-player: Doctor action(s) logged to Actions_Doctor sheet.");

        // 4. Update the Doctor's MainUsed status to TRUE and DoctorCanSaveMore to FALSE (if used)
        const updateRequests = [
            {
                range: `Players!${String.fromCharCode(65 + mainUsedCol)}${doctorPlayerRowIndex}`,
                values: [['TRUE']]
            }
        ];

        if (doctorCanSaveMoreUsed) {
            updateRequests.push({
                range: `Players!${String.fromCharCode(65 + doctorCanSaveMoreCol)}${doctorPlayerRowIndex}`,
                values: [['FALSE']]
            });
        }
        
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: updateRequests
            }
        });
        console.log(`protect-player: Doctor's MainUsed status updated to TRUE.`);
        if (doctorCanSaveMoreUsed) {
            console.log(`protect-player: DoctorCanSaveMore status updated to FALSE.`);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Done!' }),
        };

    } catch (error) {
        console.error('protect-player: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log protection action(s).', details: error.message }),
        };
    } finally {
        console.log("protect-player: Function finished.");
    }
};