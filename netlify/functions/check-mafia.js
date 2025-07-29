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
    console.log("check-mafia: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("check-mafia: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("check-mafia: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`check-mafia: Sheet ID: ${sheetId}`);

    try {
        const { detectivePlayerId, targetPlayerId } = JSON.parse(event.body);
        console.log(`check-mafia: Received - Detective: ${detectivePlayerId}, Target: ${targetPlayerId}`);
        if (!detectivePlayerId || !targetPlayerId) {
            console.log("check-mafia: Missing detectivePlayerId or targetPlayerId.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing detectivePlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();
        console.log("check-mafia: Sheets service initialized.");

        // 1. Fetch all player data to check role, action usage, and target validity
        console.log("check-mafia: Fetching Players sheet for validation.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns for server-side validation
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("check-mafia: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const historyCol = playerHeaders.indexOf('InvestigationHistory');
        const isAdminCol = playerHeaders.indexOf('IsAdmin'); // Needed for admin exemption

        if ([idCol, roleCol, statusCol, mainUsedCol, historyCol, isAdminCol].includes(-1)) {
            console.error("check-mafia: One or more required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, InvestigationHistory, IsAdmin) not found in Players sheet.");
        }

        // Map players for efficient lookup
        const playerMap = new Map();
        for(let i = 0; i < playerRows.length; i++) {
            const row = playerRows[i];
            playerMap.set(row[idCol], {data: row, index: i + 2});
        }

        // Validate Detective player
        const detectiveInfo = playerMap.get(detectivePlayerId);
        if (!detectiveInfo) {
            console.log("check-mafia: Detective player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Detective player not found.' }) };
        }
        const detectiveRowIndex = detectiveInfo.index;
        const detectiveMainUsedStatus = detectiveInfo.data[mainUsedCol] || 'FALSE';
        const detectiveRole = detectiveInfo.data[roleCol];
        const detectiveIsAdmin = detectiveInfo.data[isAdminCol] || 'FALSE';

        console.log(`check-mafia: Detective ${detectivePlayerId} found. Role: ${detectiveRole}, MainUsed: ${detectiveMainUsedStatus}, IsAdmin: ${detectiveIsAdmin}`);

        if (detectiveRole.toLowerCase() !== 'detective') {
            console.log("check-mafia: Player is not a Detective.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Detectives can use this ability.' }) };
        }
        if (detectiveMainUsedStatus === 'TRUE') {
            console.log("check-mafia: Detective has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (detectiveIsAdmin === 'TRUE') { // Admin exemption for performing actions
            console.log("check-mafia: Admin player cannot perform Detective actions.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target player
        const targetInfo = playerMap.get(targetPlayerId);
        if (!targetInfo) {
            console.log("check-mafia: Target player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Target player not found.' }) };
        }
        const targetStatus = targetInfo.data[statusCol] || '';
        const targetIsAdmin = targetInfo.data[isAdminCol] || 'FALSE';
        const targetRole = targetInfo.data[roleCol]; // Get target's role for the result
        if (targetStatus.toLowerCase() !== 'alive') {
            console.log(`check-mafia: Target (${targetPlayerId}) is not alive.`);
            return { statusCode: 400, body: JSON.stringify({ error: `Target (${targetPlayerId}) is not alive.` }) };
        }
        if (targetIsAdmin === 'TRUE') { // Admin exemption for targets
            console.log(`check-mafia: Target (${targetPlayerId}) is an Admin and cannot be targeted.`);
            return { statusCode: 403, body: JSON.stringify({ error: `Target (${targetPlayerId}) is an Admin and cannot be targeted.` }) };
        }
        if (detectivePlayerId === targetPlayerId) { // Detective cannot investigate self
            console.log("check-mafia: Detective cannot investigate self.");
            return { statusCode: 400, body: JSON.stringify({ error: 'You cannot investigate yourself.' }) };
        }
        
        const isMafiaResult = (targetRole.toLowerCase() === 'BDS342') ? 'YES' : 'NO';
        console.log(`check-mafia: Is target Mafia? ${isMafiaResult}`);

        // 2. Get current day
        console.log("check-mafia: Fetching current day from Game_State sheet.");
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`check-mafia: Current Day: ${currentDay}`);

        // 3. Log the action in the Actions_Detective sheet
        console.log("check-mafia: Appending action to Actions_Detective sheet.");
        const newActionRow = [`ACT_CHECK_${Date.now()}`, currentDay, detectivePlayerId, targetPlayerId, isMafiaResult, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Detective!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });
        console.log("check-mafia: Action logged to Actions_Detective sheet.");

        // 4. Update the detective's MainUsed and InvestigationHistory
        const newHistoryEntry = `${targetPlayerId}:${isMafiaResult}`;
        const updatedHistory = (detectiveInfo.data[historyCol] || '') ? `${(detectiveInfo.data[historyCol] || '')},${newHistoryEntry}` : newHistoryEntry;
        console.log(`check-mafia: Updating detective's MainUsed and History. New history: ${updatedHistory}`);

        const updateRequests = [
            {
                range: `Players!${String.fromCharCode(65 + mainUsedCol)}${detectiveRowIndex}`,
                values: [['TRUE']]
            },
            {
                range: `Players!${String.fromCharCode(65 + historyCol)}${detectiveRowIndex}`,
                values: [[updatedHistory]]
            }
        ];
        
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: updateRequests
            }
        });
        console.log("check-mafia: Detective's MainUsed and InvestigationHistory updated.");

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: 'Investigation has been logged.',
                isMafiaResult: isMafiaResult
            }),
        };

    } catch (error) {
        console.error('check-mafia: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log investigation.', details: error.message }),
        };
    } finally {
        console.log("check-mafia: Function finished.");
    }
};