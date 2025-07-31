// netlify/functions/shoot-player.js

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
        console.error("shoot-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let sheriffPlayerId, targetPlayerId; // CRITICAL FIX: Receive PlayerID
    try {
        const body = JSON.parse(event.body);
        sheriffPlayerId = body.sheriffPlayerId;
        targetPlayerId = body.targetPlayerId;
    } catch (e) {
        console.error("shoot-player: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!sheriffPlayerId || !targetPlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing sheriffPlayerId or targetPlayerId.' }) };
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
        const sheriffShotUsedCol = playerHeaders.indexOf('SheriffShotUsed');
        const isAdminCol = playerHeaders.indexOf('IsAdmin');

        if ([idCol, roleCol, statusCol, mainUsedCol, sheriffShotUsedCol, isAdminCol].includes(-1)) {
            console.error("shoot-player: Required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, SheriffShotUsed, IsAdmin) not found in Players sheet.");
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
                        playerShotUsed: String(playerRows[i][sheriffShotUsedCol]).trim(),
                        playerIsAdmin: String(playerRows[i][isAdminCol]).trim(),
                        rowIndex: i + 2
                    };
                }
            }
            return null;
        };

        // Validate Sheriff player
        const sheriffInfo = getPlayerInfoById(sheriffPlayerId);
        if (!sheriffInfo) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Sheriff player not found.' }) };
        }
        if (sheriffInfo.playerRole !== 'Sheriff') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Sheriffs can use this ability.' }) };
        }
        if (sheriffInfo.playerMainUsed === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (sheriffInfo.playerShotUsed === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your one-time shot.' }) };
        }
        if (sheriffInfo.playerIsAdmin === 'TRUE') {
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
        if (sheriffInfo.playerID === targetInfo.playerID) {
            return { statusCode: 400, body: JSON.stringify({ error: 'You cannot shoot yourself.' }) };
        }

        // Get current day
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? String(gameStateResponse.data.values[0][0]).trim() : 'Unknown';

        // Log the action in the Actions_Sheriff sheet
        const newActionRow = [`ACT_SHOOT_${Date.now()}`, currentDay, sheriffPlayerId, targetPlayerId, new Date().toISOString(), 'Logged'];
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Sheriff!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });

        // Update the Sheriff's MainUsed and SheriffShotUsed status
        const updateRequests = [
            {
                range: `Players!${String.fromCharCode(65 + mainUsedCol)}${sheriffInfo.rowIndex}`,
                values: [['TRUE']]
            },
            {
                range: `Players!${String.fromCharCode(65 + sheriffShotUsedCol)}${sheriffInfo.rowIndex}`,
                values: [['TRUE']]
            }
        ];
        
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
            body: JSON.stringify({ message: 'Shoot action has been successfully logged.' }),
        };

    } catch (error) {
        console.error('shoot-player: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log shoot action.', details: error.message }),
        };
    } finally {
    }
};