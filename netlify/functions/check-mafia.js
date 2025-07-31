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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("check-mafia: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let detectivePlayerId, targetPlayerId; // CRITICAL FIX: Receive PlayerID
    try {
        const body = JSON.parse(event.body);
        detectivePlayerId = body.detectivePlayerId;
        targetPlayerId = body.targetPlayerId;
    } catch (e) {
        console.error("check-mafia: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!detectivePlayerId || !targetPlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing detectivePlayerId or targetPlayerId.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // Fetch all player data to validate
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns needed for validation
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const historyCol = playerHeaders.indexOf('InvestigationHistory');
        const isAdminCol = playerHeaders.indexOf('IsAdmin');

        if ([idCol, roleCol, statusCol, mainUsedCol, historyCol, isAdminCol].includes(-1)) {
            console.error("check-mafia: Required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, InvestigationHistory, IsAdmin) not found in Players sheet.");
        }

        // Helper to get player info by ID
        const getPlayerInfoById = (id) => {
            for (let i = 0; i < playerRows.length; i++) {
                if (String(playerRows[i][idCol]).trim() === id) {
                    return {
                        playerID: String(playerRows[i][idCol]).trim(),
                        playerRole: String(playerRows[i][roleCol]).trim(),
                        playerStatus: String(playerRows[i][statusCol]).trim(),
                        playerMainUsed: String(playerRows[i][mainUsedCol]).trim(),
                        playerHistory: String(playerRows[i][historyCol]).trim(),
                        playerIsAdmin: String(playerRows[i][isAdminCol]).trim(),
                        rowIndex: i + 2
                    };
                }
            }
            return null;
        };

        // Validate Detective player
        const detectiveInfo = getPlayerInfoById(detectivePlayerId);
        if (!detectiveInfo) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Detective player not found.' }) };
        }
        if (detectiveInfo.playerRole !== 'LAP302') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Detectives can use this ability.' }) };
        }
        if (detectiveInfo.playerMainUsed === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (detectiveInfo.playerIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target player
        const targetInfo = getPlayerInfoById(targetPlayerId);
        if (!targetInfo) {
            return { statusCode: 404, body: JSON.stringify({ error: `Target (${targetPlayerId}) not found.` }) };
        }
        if (targetInfo.playerStatus.toLowerCase() !== 'alive') {
            return { statusCode: 400, body: JSON.stringify({ error: `Target (${targetPlayerId}) is not alive.` }) };
        }
        if (targetInfo.playerIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: `Target (${targetPlayerId}) is an Admin and cannot be targeted.` }) };
        }
        if (detectiveInfo.playerID === targetInfo.playerID) {
            return { statusCode: 400, body: JSON.stringify({ error: 'You cannot investigate yourself.' }) };
        }
        
        const isMafiaResult = (targetInfo.playerRole === 'BDS342') ? 'YES' : 'NO';
        
        // Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? String(gameStateResponse.data.values[0][0]).trim() : 'Unknown';

        // Log the action in the Actions_Detective sheet
        const newActionRow = [`ACT_CHECK_${Date.now()}`, currentDay, detectivePlayerId, targetPlayerId, isMafiaResult, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Detective!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });

        // Update the detective's MainUsed and InvestigationHistory
        const newHistoryEntry = `${targetPlayerId}:${isMafiaResult}`;
        const updatedHistory = detectiveInfo.playerHistory ? `${detectiveInfo.playerHistory},${newHistoryEntry}` : newHistoryEntry;

        const updateRequests = [
            {
                range: `Players!${String.fromCharCode(65 + mainUsedCol)}${detectiveInfo.rowIndex}`,
                values: [['TRUE']]
            },
            {
                range: `Players!${String.fromCharCode(65 + historyCol)}${detectiveInfo.rowIndex}`,
                values: [['TRUE']] // Assuming history is a separate column
            }
        ];
        // Ensure historyCol is correctly updated
        const historyColIndex = playerHeaders.indexOf('InvestigationHistory');
        if (historyColIndex !== -1) {
            updateRequests[1].range = `Players!${String.fromCharCode(65 + historyColIndex)}${detectiveInfo.rowIndex}`;
            updateRequests[1].values = [[updatedHistory]];
        } else {
            console.warn("check-mafia: InvestigationHistory column not found, history will not be updated.");
            updateRequests.pop(); // Remove the history update if column not found
        }
        
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: updateRequests
            }
        });

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
    }
};