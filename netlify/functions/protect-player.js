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
        console.log(`protect-player: Received - Doctor: ${doctorPlayerId}, Target 1: ${targetPlayerId1}, Target 2: ${targetPlayerId2 || 'N/A'}, CanSaveMoreUsed: ${doctorCanSaveMoreUsed}`);
        
        if (!doctorPlayerId || !targetPlayerId1 || (doctorCanSaveMoreUsed && !targetPlayerId2)) {
            console.log("protect-player: Missing doctorPlayerId or targetPlayerId(s).");
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing doctorPlayerId or targetPlayerId(s).' }) };
        }

        const sheets = await getSheetsService();
        console.log("protect-player: Sheets service initialized.");

        // 1. Fetch player data to check role, action usage, and ability status
        console.log("protect-player: Fetching Players sheet for validation.");
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch all columns for server-side validation
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("protect-player: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const roleCol = playerHeaders.indexOf('Role'); // Needed for role validation
        const statusCol = playerHeaders.indexOf('Status'); // Needed for status validation
        const mainUsedCol = playerHeaders.indexOf('MainUsed');
        const doctorCanSaveMoreCol = playerHeaders.indexOf('DoctorCanSaveMore');
        const isAdminCol = playerHeaders.indexOf('IsAdmin'); // Needed for admin exemption

        if ([idCol, roleCol, statusCol, mainUsedCol, doctorCanSaveMoreCol, isAdminCol].includes(-1)) {
            console.error("protect-player: One or more required columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Role, Status, MainUsed, DoctorCanSaveMore, IsAdmin) not found in Players sheet.");
        }

        let doctorPlayerRowIndex = -1;
        let doctorMainUsedStatus = 'FALSE';
        let doctorCanSaveMoreStatus = 'FALSE';
        let doctorRole = '';
        let doctorIsAdmin = 'FALSE';

        let target1Status = '';
        let target1IsAdmin = 'FALSE';
        let target2Status = '';
        let target2IsAdmin = 'FALSE';

        // Map players for efficient lookup
        const playerMap = new Map(); // Map<PlayerID, {data: row, index: i+2}>
        for(let i = 0; i < playerRows.length; i++) {
            const row = playerRows[i];
            playerMap.set(row[idCol], {data: row, index: i + 2});
        }

        // Validate Doctor
        const doctorInfo = playerMap.get(doctorPlayerId);
        if (!doctorInfo) {
            console.log("protect-player: Doctor player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Doctor player not found.' }) };
        }
        doctorPlayerRowIndex = doctorInfo.index;
        doctorMainUsedStatus = doctorInfo.data[mainUsedCol] || 'FALSE';
        doctorCanSaveMoreStatus = doctorInfo.data[doctorCanSaveMoreCol] || 'FALSE';
        doctorRole = doctorInfo.data[roleCol];
        doctorIsAdmin = doctorInfo.data[isAdminCol] || 'FALSE';

        console.log(`protect-player: Doctor ${doctorPlayerId} found. Role: ${doctorRole}, MainUsed: ${doctorMainUsedStatus}, CanSaveMore: ${doctorCanSaveMoreStatus}, IsAdmin: ${doctorIsAdmin}`);

        if (doctorRole.toLowerCase() !== 'FQP982') {
            console.log("protect-player: Player is not a Doctor.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Doctors can use this ability.' }) };
        }
        if (doctorMainUsedStatus === 'TRUE') {
            console.log("protect-player: Doctor has already used action for tonight.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You have already used your action for tonight.' }) };
        }
        if (doctorCanSaveMoreUsed && doctorCanSaveMoreStatus !== 'TRUE') {
            console.log("protect-player: Doctor tried to save more but does not have the ability.");
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to save more players.' }) };
        }
        if (doctorIsAdmin === 'TRUE') { // Admin exemption for performing actions
            console.log("protect-player: Admin player cannot perform Doctor actions.");
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // Validate Target 1
        const target1Info = playerMap.get(targetPlayerId1);
        if (!target1Info) {
            console.log("protect-player: Target 1 player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Target 1 player not found.' }) };
        }
        target1Status = target1Info.data[statusCol] || '';
        target1IsAdmin = target1Info.data[isAdminCol] || 'FALSE';
        if (target1Status.toLowerCase() !== 'alive') {
            console.log(`protect-player: Target 1 (${targetPlayerId1}) is not alive.`);
            return { statusCode: 400, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is not alive.` }) };
        }
        if (target1IsAdmin === 'TRUE') {
            console.log(`protect-player: Target 1 (${targetPlayerId1}) is an Admin and cannot be targeted.`);
            return { statusCode: 403, body: JSON.stringify({ error: `Target 1 (${targetPlayerId1}) is an Admin and cannot be targeted.` }) };
        }

        // Validate Target 2 (if applicable)
        if (doctorCanSaveMoreUsed && targetPlayerId2) {
            const target2Info = playerMap.get(targetPlayerId2);
            if (!target2Info) {
                console.log("protect-player: Target 2 player not found in sheet.");
                return { statusCode: 404, body: JSON.stringify({ error: 'Target 2 player not found.' }) };
            }
            target2Status = target2Info.data[statusCol] || '';
            target2IsAdmin = target2Info.data[isAdminCol] || 'FALSE';
            if (target2Status.toLowerCase() !== 'alive') {
                console.log(`protect-player: Target 2 (${targetPlayerId2}) is not alive.`);
                return { statusCode: 400, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is not alive.` }) };
            }
            if (target2IsAdmin === 'TRUE') {
                console.log(`protect-player: Target 2 (${targetPlayerId2}) is an Admin and cannot be targeted.`);
                return { statusCode: 403, body: JSON.stringify({ error: `Target 2 (${targetPlayerId2}) is an Admin and cannot be targeted.` }) };
            }
            if (targetPlayerId1 === targetPlayerId2) {
                console.log("protect-player: Both targets are the same.");
                return { statusCode: 400, body: JSON.stringify({ error: 'You must select two different players to protect.' }) };
            }
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
            body: JSON.stringify({ message: 'Protection action(s) successfully logged and action marked as used.' }),
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