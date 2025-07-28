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
    console.log("kill-player: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("kill-player: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("kill-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`kill-player: Sheet ID: ${sheetId}`);

    try {
        const { mafiaPlayerId, targetPlayerId1, targetPlayerId2 } = JSON.parse(event.body);
        console.log(`kill-player: Received - Mafia: ${mafiaPlayerId}, Target 1: ${targetPlayerId1}, Target 2: ${targetPlayerId2}`);
        if (!mafiaPlayerId || !targetPlayerId1 || !targetPlayerId2) {
            console.log("kill-player: Missing mafiaPlayerId or one of the targetPlayerIds.");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId or targetPlayerIds.' }) };
        }

        const sheets = await getSheetsService();
        console.log("kill-player: Sheets service initialized.");

        // 1. Fetch all player data to check role, action usage, and target validity
        console.log("kill-player: Fetching Players sheet for validation.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns for server-side validation
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("kill-player: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const mainUsedCol = 20; // Explicitly set to column U (0-indexed)
        const isAdminCol = playerHeaders.indexOf('IsAdmin'); // Needed for admin exemption

        if (idCol === -1 || roleCol === -1 || statusCol === -1 || isAdminCol === -1) {
            console.error("kill-player: Required columns 'PlayerID', 'Role', 'Status', or 'IsAdmin' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID', 'Role', 'Status', or 'IsAdmin' not found in Players sheet.");
        }
        // mainUsedCol is hardcoded, so no need to check its indexOf result here.

        // Map players for efficient lookup
        const playerMap = new Map(); // Map<PlayerID, {data: row, index: i+2}>
        for(let i = 0; i < playerRows.length; i++) {
            const row = playerRows[i];
            playerMap.set(row[idCol], {data: row, index: i + 2});
        }

        // Validate Mafia player
        const mafiaInfo = playerMap.get(mafiaPlayerId);
        if (!mafiaInfo) {
            console.log("kill-player: Mafia player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found.' }) };
        }
        const mafiaPlayerRowIndex = mafiaInfo.index;
        const mafiaMainUsedStatus = (mainUsedCol < mafiaInfo.data.length ? mafiaInfo.data[mainUsedCol] : '') || 'FALSE';
        const mafiaRole = mafiaInfo.data[roleCol];
        const mafiaIsAdmin = mafiaInfo.data[isAdminCol] || 'FALSE';

        console.log(`kill-player: Mafia player ${mafiaPlayerId} found. Role: ${mafiaRole}, MainUsed: ${mafiaMainUsedStatus}, IsAdmin: ${mafiaIsAdmin}`);

        if (mafiaRole.toLowerCase() !== 'mafia') {
            console.log("kill-player: Player is not Mafia.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Mafia can use this ability.' }) };
        }
        if (mafiaMainUsedStatus === 'TRUE') {
            console.log("kill-player: Mafia has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (mafiaIsAdmin === 'TRUE') { // Admin exemption for performing actions
            console.log("kill-player: Admin player cannot perform Mafia actions.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target 1
        const target1Info = playerMap.get(targetPlayerId1);
        if (!target1Info) {
            console.log("kill-player: Target 1 player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Target 1 player not found.' }) };
        }
        const target1Status = target1Info.data[statusCol] || '';
        const target1IsAdmin = target1Info.data[isAdminCol] || 'FALSE';
        if (target1Status.toLowerCase() !== 'alive') {
            console.log(`kill-player: Target 1 (${targetPlayerId1}) is not alive.`);
            return { statusCode: 400, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is not alive.` }) };
        }
        if (target1IsAdmin === 'TRUE') { // Admin exemption for targets
            console.log(`kill-player: Target 1 (${targetPlayerId1}) is an Admin and cannot be targeted.`);
            return { statusCode: 403, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is an Admin and cannot be targeted.` }) };
        }

        // Validate Target 2
        const target2Info = playerMap.get(targetPlayerId2);
        if (!target2Info) {
            console.log("kill-player: Target 2 player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Target 2 player not found.' }) };
        }
        const target2Status = target2Info.data[statusCol] || '';
        const target2IsAdmin = target2Info.data[isAdminCol] || 'FALSE';
        if (target2Status.toLowerCase() !== 'alive') {
            console.log(`kill-player: Target 2 (${targetPlayerId2}) is not alive.`);
            return { statusCode: 400, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is not alive.` }) };
        }
        if (target2IsAdmin === 'TRUE') { // Admin exemption for targets
            console.log(`kill-player: Target 2 (${targetPlayerId2}) is an Admin and cannot be targeted.`);
            return { statusCode: 403, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is an Admin and cannot be targeted.` }) };
        }
        if (targetPlayerId1 === targetPlayerId2) {
            console.log("kill-player: Both targets are the same.");
            return { statusCode: 400, body: JSON.stringify({ error: 'You must select two different players to kill.' }) };
        }


        // 2. Get current day
        console.log("kill-player: Fetching current day from Game_State sheet.");
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!A2:A2',
        });
        const currentDay = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : 'Unknown';
        console.log(`kill-player: Current Day: ${currentDay}`);

        // 3. Log the action (two separate entries)
        const timestamp = new Date().toISOString();
        const actionsToLog = [];

        actionsToLog.push([`ACT_KILL_${Date.now()}_1`, currentDay, mafiaPlayerId, targetPlayerId1, timestamp, null, 'Logged']);
        console.log(`kill-player: Appending action for Target 1 (${targetPlayerId1}) to Actions_Mafia sheet.`);

        actionsToLog.push([`ACT_KILL_${Date.now()}_2`, currentDay, mafiaPlayerId, targetPlayerId2, timestamp, null, 'Logged']);
        console.log(`kill-player: Appending action for Target 2 (${targetPlayerId2}) to Actions_Mafia sheet.`);
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Actions_Mafia!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: actionsToLog }, // Append both actions in one go
        });
        console.log("kill-player: Mafia actions logged to Actions_Mafia sheet.");

        // 4. Update the Mafia player's MainUsed status to TRUE
        const updateRange = `Players!${String.fromCharCode(65 + mainUsedCol)}${mafiaPlayerRowIndex}`;
        console.log(`kill-player: Updating Mafia's MainUsed status for ${mafiaPlayerId} at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['TRUE']] },
        });
        console.log(`kill-player: Mafia's MainUsed status for ${mafiaPlayerId} updated to TRUE.`);

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
        console.log("kill-player: Function finished.");
    }
};