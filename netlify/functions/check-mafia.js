// netlify/functions/check-mafia.js

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
    console.log("check-mafia: Function started."); // LOG 1
    if (event.httpMethod !== 'POST') {
        console.log("check-mafia: Method Not Allowed."); // LOG 2
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("check-mafia: Google Sheet ID is not configured."); // LOG 3
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`check-mafia: Sheet ID: ${sheetId}`); // LOG 4

    try {
        const { detectivePlayerId, targetPlayerId } = JSON.parse(event.body); // Renamed checkedPlayerId to targetPlayerId for consistency
        console.log(`check-mafia: Received - Detective: ${detectivePlayerId}, Target: ${targetPlayerId}`); // LOG 5
        if (!detectivePlayerId || !targetPlayerId) {
            console.log("check-mafia: Missing detectivePlayerId or targetPlayerId."); // LOG 6
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing detectivePlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();
        console.log("check-mafia: Sheets service initialized."); // LOG 7

        // 1. Get all player data
        console.log("check-mafia: Fetching Players sheet for action usage check and target role."); // LOG 8
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns to ensure 'MainUsed' and 'InvestigationHistory' are found
        });
        const playersData = playersResponse.data.values || []; // Renamed to playersData to avoid conflict with players.slice(1)
        if (playersData.length < 1) {
            console.error("check-mafia: Players sheet is empty."); // LOG 9
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1); // Renamed to playerRows for clarity
        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const historyCol = playerHeaders.indexOf('InvestigationHistory');

        console.log(`check-mafia: PlayerID index: ${idCol}, Role index: ${roleCol}, MainUsed index: ${mainUsedCol}, History index: ${historyCol}`); // LOG 10

        if ([idCol, roleCol, mainUsedCol, historyCol].includes(-1)) {
            console.error("check-mafia: One or more required columns (PlayerID, Role, MainUsed, InvestigationHistory) not found in Players sheet."); // LOG 11
            throw new Error("One or more required columns (PlayerID, Role, MainUsed, InvestigationHistory) not found in Players sheet.");
        }

        // 2. Find the detective and check their status
        let detectiveRowIndex = -1;
        let detectiveMainUsedStatus = 'FALSE';
        let currentHistory = '';
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === detectivePlayerId) {
                detectiveRowIndex = i + 2; // +2 for 0-index and header row
                detectiveMainUsedStatus = playerRows[i][mainUsedCol] || 'FALSE';
                currentHistory = playerRows[i][historyCol] || '';
                break;
            }
        }
        console.log(`check-mafia: Detective ${detectivePlayerId} found at row ${detectiveRowIndex}. MainUsed status: ${detectiveMainUsedStatus}, Current History: ${currentHistory}`); // LOG 12

        if (detectiveRowIndex === -1) {
            console.log("check-mafia: Detective player not found in sheet."); // LOG 13
            return { statusCode: 404, body: JSON.stringify({ error: 'Detective player not found.' }) };
        }
        if (detectiveMainUsedStatus === 'TRUE') {
            console.log("check-mafia: Detective has already used action for tonight."); // LOG 14
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        
        // 3. Find the target's role
        let targetRole = null;
        for (const playerRow of playerRows) { // Iterate over playerRows, not players.slice(1) again
            if (playerRow[idCol] === targetPlayerId) {
                targetRole = playerRow[roleCol];
                break;
            }
        }
        console.log(`check-mafia: Target ${targetPlayerId} role: ${targetRole}`); // LOG 15
        if (!targetRole) {
            console.log("check-mafia: Target player not found."); // LOG 16
            return { statusCode: 404, body: JSON.stringify({ error: 'Target player not found.' }) };
        }
        const isMafiaResult = (targetRole.toLowerCase() === 'mafia') ? 'YES' : 'NO';
        console.log(`check-mafia: Is target Mafia? ${isMafiaResult}`); // LOG 17

        // 4. Get current day
        console.log("check-mafia: Fetching current day from Game_State sheet."); // LOG 18
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`check-mafia: Current Day: ${currentDay}`); // LOG 19

        // 5. Log the action in the Actions_Detective sheet
        console.log("check-mafia: Appending action to Actions_Detective sheet."); // LOG 20
        const newActionRow = [`ACT_CHECK_${Date.now()}`, currentDay, detectivePlayerId, targetPlayerId, isMafiaResult, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Detective!A:G', // Ensure this range covers all columns you're writing
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });
        console.log("check-mafia: Action logged to Actions_Detective sheet."); // LOG 21

        // 6. Update the detective's MainUsed and InvestigationHistory
        const newHistoryEntry = `${targetPlayerId}:${isMafiaResult}`;
        const updatedHistory = currentHistory ? `${currentHistory},${newHistoryEntry}` : newHistoryEntry;
        console.log(`check-mafia: Updating detective's MainUsed and History. New history: ${updatedHistory}`); // LOG 22

        // Assuming 'MainUsed' is before 'InvestigationHistory' in the sheet
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${detectiveRowIndex}:${String.fromCharCode(65 + historyCol)}${detectiveRowIndex}`;
        console.log(`check-mafia: Updating Players sheet at range: ${updateRange}`); // LOG 23
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE', updatedHistory]] },
        });
        console.log("check-mafia: Detective's MainUsed and InvestigationHistory updated."); // LOG 24

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: 'Investigation has been logged.',
                isMafiaResult: isMafiaResult
            }),
        };

    } catch (error) {
        console.error('check-mafia: Error in try-catch block:', error); // LOG 25
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log investigation.', details: error.message }),
        };
    } finally {
        console.log("check-mafia: Function finished."); // LOG 26
    }
};