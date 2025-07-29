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
    console.log("shoot-player: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("shoot-player: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("shoot-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`shoot-player: Sheet ID: ${sheetId}`);

    try {
        const { sheriffPlayerId, targetPlayerId } = JSON.parse(event.body);
        console.log(`shoot-player: Received - Sheriff: ${sheriffPlayerId}, Target: ${targetPlayerId}`);
        if (!sheriffPlayerId || !targetPlayerId) {
            console.log("shoot-player: Missing sheriffPlayerId or targetPlayerId.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing sheriffPlayerId or targetPlayerId.' }) };
        }

        const sheets = await getSheetsService();
        console.log("shoot-player: Sheets service initialized.");

        // 1. Fetch all player data to check role, action usage, and target validity
        console.log("shoot-player: Fetching Players sheet for validation.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns for server-side validation
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("shoot-player: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const sheriffShotUsedCol = playerHeaders.indexOf('SheriffShotUsed'); // Assuming this column exists
        const isAdminCol = playerHeaders.indexOf('IsAdmin'); // Needed for admin exemption

        if ([idCol, roleCol, statusCol, mainUsedCol, sheriffShotUsedCol, isAdminCol].includes(-1)) {
            console.error("shoot-player: One or more required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, SheriffShotUsed, IsAdmin) not found in Players sheet.");
        }

        // Map players for efficient lookup
        const playerMap = new Map();
        for(let i = 0; i < playerRows.length; i++) {
            const row = playerRows[i];
            playerMap.set(row[idCol], {data: row, index: i + 2});
        }

        // Validate Sheriff player
        const sheriffInfo = playerMap.get(sheriffPlayerId);
        if (!sheriffInfo) {
            console.log("shoot-player: Sheriff player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Sheriff player not found.' }) };
        }
        const sheriffPlayerRowIndex = sheriffInfo.index;
        const sheriffMainUsedStatus = sheriffInfo.data[mainUsedCol] || 'FALSE';
        const sheriffShotUsedStatus = sheriffInfo.data[sheriffShotUsedCol] || 'FALSE';
        const sheriffRole = sheriffInfo.data[roleCol];
        const sheriffIsAdmin = sheriffInfo.data[isAdminCol] || 'FALSE';

        console.log(`shoot-player: Sheriff ${sheriffPlayerId} found. Role: ${sheriffRole}, MainUsed: ${sheriffMainUsedStatus}, ShotUsed: ${sheriffShotUsedStatus}, IsAdmin: ${sheriffIsAdmin}`);

        if (sheriffRole.toLowerCase() !== 'QRW438') {
            console.log("shoot-player: Player is not a Sheriff.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Sheriffs can use this ability.' }) };
        }
        if (sheriffMainUsedStatus === 'TRUE') {
            console.log("shoot-player: Sheriff has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (sheriffShotUsedStatus === 'TRUE') {
            console.log("shoot-player: Sheriff has already used their one-time shot.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your one-time shot.' }) };
        }
        if (sheriffIsAdmin === 'TRUE') { // Admin exemption for performing actions
            console.log("shoot-player: Admin player cannot perform Sheriff actions.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target player
        const targetInfo = playerMap.get(targetPlayerId);
        if (!targetInfo) {
            console.log("shoot-player: Target player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Target player not found.' }) };
        }
        const targetStatus = targetInfo.data[statusCol] || '';
        const targetIsAdmin = targetInfo.data[isAdminCol] || 'FALSE';
        if (targetStatus.toLowerCase() !== 'alive') {
            console.log(`shoot-player: Target (${targetPlayerId}) is not alive.`);
            return { statusCode: 400, body: JSON.stringify({ error: `Target (${targetPlayerId}) is not alive.` }) };
        }
        if (targetIsAdmin === 'TRUE') { // Admin exemption for targets
            console.log(`shoot-player: Target (${targetPlayerId}) is an Admin and cannot be targeted.`);
            return { statusCode: 403, body: JSON.stringify({ error: `Target (${targetPlayerId}) is an Admin and cannot be targeted.` }) };
        }
        if (sheriffPlayerId === targetPlayerId) { // Sheriff cannot shoot self
            console.log("shoot-player: Sheriff cannot shoot self.");
            return { statusCode: 400, body: JSON.stringify({ error: 'You cannot shoot yourself.' }) };
        }

        // 2. Get current day
        console.log("shoot-player: Fetching current day from Game_State sheet.");
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`shoot-player: Current Day: ${currentDay}`);

        // 3. Log the action in the Actions_Sheriff sheet
        console.log("shoot-player: Appending action to Actions_Sheriff sheet.");
        const newActionRow = [`ACT_SHOOT_${Date.now()}`, currentDay, sheriffPlayerId, targetPlayerId, new Date().toISOString(), 'Logged']; // Note: Sheriff sheet has 6 columns
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Sheriff!A:F', // Range A:F for 6 columns
            valueInputOption: 'USER_ENTERED',
            resource: { values: [newActionRow] },
        });
        console.log("shoot-player: Action logged to Actions_Sheriff sheet.");

        // 4. Update the Sheriff's MainUsed and SheriffShotUsed status
        const updateRequests = [
            {
                range: `Players!${String.fromCharCode(65 + mainUsedCol)}${sheriffPlayerRowIndex}`,
                values: [['TRUE']]
            },
            {
                range: `Players!${String.fromCharCode(65 + sheriffShotUsedCol)}${sheriffPlayerRowIndex}`,
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
        console.log("shoot-player: Sheriff's MainUsed and SheriffShotUsed status updated to TRUE.");

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
        console.log("shoot-player: Function finished.");
    }
};