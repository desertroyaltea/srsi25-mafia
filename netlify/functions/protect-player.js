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
    console.log("protect-player: Function started."); // LOG 1
    if (event.httpMethod !== 'POST') {
        console.log("protect-player: Method Not Allowed."); // LOG 2
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("protect-player: Google Sheet ID is not configured."); // LOG 3
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`protect-player: Sheet ID: ${sheetId}`); // LOG 4

    try {
const { doctorPlayerId, targetPlayerId1, targetPlayerId2, doctorCanSaveMoreUsed } = JSON.parse(event.body); // NEW: Receive two targets and ability usage
        console.log(`protect-player: Received - Doctor: ${doctorPlayerId}, Target: ${targetPlayerId}`); // LOG 5
if (!doctorPlayerId || !targetPlayerId1 || (doctorCanSaveMoreUsed && !targetPlayerId2)) { // Validate based on ability usage
            console.log("protect-player: Missing doctorPlayerId or targetPlayerId(s).");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId or targetPlayerId(s).' }) };
        }

        const sheets = await getSheetsService();
        console.log("protect-player: Sheets service initialized."); // LOG 7

        // 1. Check if the player has already used their action
        console.log("protect-player: Fetching Players sheet for action usage check."); // LOG 8
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'MainUsed' is found
        });
        const players = playersResponse.data.values || [];
        if (players.length < 1) {
            console.error("protect-player: Players sheet is empty."); // LOG 9
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = players[0];
        const playerRows = players.slice(1);
        const idCol = playerHeaders.indexOf('PlayerID');
const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const doctorCanSaveMoreCol = playerHeaders.indexOf('DoctorCanSaveMore'); // NEW column index

        console.log(`protect-player: PlayerID column index: ${idCol}, MainUsed column index: ${mainUsedCol}`); // LOG 10

if (idCol === -1 || mainUsedCol === -1 || doctorCanSaveMoreCol === -1) { // NEW: Check for DoctorCanSaveMore
            console.error("protect-player: Required columns 'PlayerID', 'MainUsed', or 'DoctorCanSaveMore' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID', 'MainUsed', or 'DoctorCanSaveMore' not found in Players sheet.");
        }

        let doctorPlayerRowIndex = -1;
        let doctorMainUsedStatus = 'FALSE'; // Default
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === doctorPlayerId) {
                doctorPlayerRowIndex = i + 2; // +2 for 0-index and header row
                doctorMainUsedStatus = playerRows[i][mainUsedCol] || 'FALSE';
                break;
            }
        }
        console.log(`protect-player: Doctor ${doctorPlayerId} found at row ${doctorPlayerRowIndex}. MainUsed status: ${doctorMainUsedStatus}`); // LOG 12

        if (doctorPlayerRowIndex === -1) {
            console.log("protect-player: Doctor player not found in sheet."); // LOG 13
            return { statusCode: 404, body: JSON.stringify({ error: 'Doctor player not found.' }) };
        }
        if (doctorMainUsedStatus === 'TRUE') {
            console.log("protect-player: Doctor has already used action for tonight."); // LOG 14
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }

        // 2. Get current day
        console.log("protect-player: Fetching current day from Game_State sheet."); // LOG 15
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2', // Assuming CurrentDay is in A2
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`protect-player: Current Day: ${currentDay}`); // LOG 16

// 3. Log the action(s)
     const timestamp = new Date().toISOString();
     const actionsToLog = [];

     actionsToLog.push([`ACT_PROTECT_${Date.now()}_1`, currentDay, doctorPlayerId, targetPlayerId1, timestamp, null, 'Logged']);
     console.log(`protect-player: Appending action for Target 1 (${targetPlayerId1}) to Actions_Doctor sheet.`);

     if (doctorCanSaveMoreUsed && targetPlayerId2) {
         actionsToLog.push([`ACT_PROTECT_${Date.now()}_2`, currentDay, doctorPlayerId, targetPlayerId2, timestamp, null, 'Logged']);
         console.log(`protect-player: Appending action for Target 2 (${targetPlayerId2}) to Actions_Doctor sheet.`);
     }

     // Append all actions in one batch for efficiency
     await sheets.spreadsheets.values.append({
         spreadsheetId: sheetId,
         range: 'Actions_Doctor!A:G',
         valueInputOption: 'USER_ENTERED',
         resource: { values: actionsToLog },
     });
     console.log("protect-player: Doctor action(s) logged to Actions_Doctor sheet.");

     // 4. Update the Doctor's MainUsed status to TRUE and DoctorCanSaveMore to FALSE
     const updateRangeMainUsed = `Players!${String.fromCharCode(65 + mainUsedCol)}${doctorPlayerRowIndex}`;
     const updateRangeCanSaveMore = `Players!${String.fromCharCode(65 + doctorCanSaveMoreCol)}${doctorPlayerRowIndex}`;

     const updateRequests = [
         {
             range: updateRangeMainUsed,
             values: [['TRUE']]
         }
     ];

     if (doctorCanSaveMoreUsed) {
         updateRequests.push({
             range: updateRangeCanSaveMore,
             values: [['FALSE']]
         });
     }

     // Use batchUpdate to update both fields in one API call
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

        // 4. Update the player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${doctorPlayerRowIndex}`;
        console.log(`protect-player: Updating Doctor's MainUsed status at range: ${updateRange}`); // LOG 19
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });
        console.log("protect-player: Doctor's MainUsed status updated to TRUE."); // LOG 20

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Protection action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('protect-player: Error in try-catch block:', error); // LOG 21
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log protection action.', details: error.message }),
        };
    } finally {
        console.log("protect-player: Function finished."); // LOG 22
    }
};