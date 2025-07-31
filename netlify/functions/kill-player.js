// netlify/functions/kill-player.js

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
        console.error("kill-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let mafiaPlayerId, targetPlayerId1, targetPlayerId2; // CRITICAL FIX: Receive PlayerIDs directly
    try {
        const body = JSON.parse(event.body);
        mafiaPlayerId = body.mafiaPlayerId;
        targetPlayerId1 = body.targetPlayerId1;
        targetPlayerId2 = body.targetPlayerId2;
    } catch (e) {
        console.error("kill-player: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!mafiaPlayerId || !targetPlayerId1 || !targetPlayerId2) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId or targetPlayerIds.' }) };
    }
    if (targetPlayerId1 === targetPlayerId2) {
        return { statusCode: 400, body: JSON.stringify({ error: 'You must select two different players to kill.' }) };
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
        const isAdminCol = playerHeaders.indexOf('IsAdmin');

        if ([idCol, roleCol, statusCol, mainUsedCol, isAdminCol].includes(-1)) {
            console.error("kill-player: Required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, IsAdmin) not found in Players sheet.");
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
                        playerIsAdmin: String(playerRows[i][isAdminCol]).trim(),
                        rowIndex: i + 2
                    };
                }
            }
            return null;
        };

        // Validate Mafia player
        const mafiaInfo = getPlayerInfoById(mafiaPlayerId);
        if (!mafiaInfo) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found.' }) };
        }
        if (mafiaInfo.playerRole !== 'BDS342') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Mafia can use this ability.' }) };
        }
        if (mafiaInfo.playerMainUsed === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (mafiaInfo.playerIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target 1
        const target1Info = getPlayerInfoById(targetPlayerId1);
        if (!target1Info) {
            return { statusCode: 404, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) not found.` }) };
        }
        if (target1Info.playerStatus.toLowerCase() !== 'alive') {
            return { statusCode: 400, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is not alive.` }) };
        }
        if (target1Info.playerIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is an Admin and cannot be targeted.` }) };
        }

        // Validate Target 2
        const target2Info = getPlayerInfoById(targetPlayerId2);
        if (!target2Info) {
            return { statusCode: 404, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) not found.` }) };
        }
        if (target2Info.playerStatus.toLowerCase() !== 'alive') {
            return { statusCode: 400, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is not alive.` }) };
        }
        if (target2Info.playerIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is an Admin and cannot be targeted.` }) };
        }

        // Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? String(gameStateResponse.data.values[0][0]).trim() : 'Unknown';

        // Log the action (two separate entries)
        const timestamp = new Date().toISOString();
        const actionsToLog = [];

        actionsToLog.push([`ACT_KILL_${Date.now()}_1`, currentDay, mafiaPlayerId, targetPlayerId1, timestamp, null, 'Logged']);
        actionsToLog.push([`ACT_KILL_${Date.now()}_2`, currentDay, mafiaPlayerId, targetPlayerId2, timestamp, null, 'Logged']);
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Mafia!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: actionsToLog },
        });

        // Update the Mafia player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${mafiaInfo.rowIndex}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Kill action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('kill-player: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log kill action.', details: error.message }),
        };
    } finally {
    }
};