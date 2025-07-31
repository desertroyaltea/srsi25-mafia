// netlify/functions/get-player-data.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only scope
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("get-player-data: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-player-data: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-player-data: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`get-player-data: Sheet ID: ${sheetId}`);

    const requestedPlayerId = event.queryStringParameters.playerId; // Check if a specific player ID is requested
    console.log(`get-player-data: Requested Player ID: ${requestedPlayerId || 'None (fetching all public data)'}`);

    try {
        const sheets = await getSheetsService();
        console.log("get-player-data: Sheets service initialized.");

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AA', // Fetch all columns up to AA (Welcome)
        });

        const allPlayersRawData = playersResponse.data.values || [];
        if (allPlayersRawData.length < 1) {
            console.log("get-player-data: Players sheet is empty.");
            return { statusCode: 200, body: JSON.stringify([]) };
        }

        const headers = allPlayersRawData[0];
        const playerRows = allPlayersRawData.slice(1);

        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name'); // Ensure Name column is found
        const statusCol = headers.indexOf('Status'); // Ensure Status column is found
        const isAdminCol = headers.indexOf('IsAdmin'); // Ensure IsAdmin column is found

        if ([idCol, nameCol, statusCol, isAdminCol].includes(-1)) {
            console.error("get-player-data: Required public columns not found in Players sheet (PlayerID, Name, Status, IsAdmin).");
            throw new Error("Required public columns not found in Players sheet.");
        }

        const sensitivePlayerFields = [ // Fields only sent for the requested player
            'Passcode', 'Role', 'CurrentVotingPower', 'MissionsCompleted',
            'MafiaCanConvert', 'MafiaCanRevealSelf', 'VillagerCanIncreaseVote',
            'VillagerCanChangeRole', 'DoctorCanSaveMore', 'DoctorCanRevive',
            'DoctorCanRevealSelf', 'DetectiveCanRevealSelf', 'DoctorSavesRemaining',
            'SheriffShotUsed', 'IsJuryMember', 'OriginalRole', 'MainUsed',
            'InvestigationHistory', 'Jury', 'RevealedTeammates', 'NightVoteUsed', 'IsProtected', 'Welcome'
        ];

        const allPublicPlayersData = []; // Store public data for all players
        let requestedPlayerData = null; // Store full data for the requested player

        for (const row of playerRows) {
            const currentPlayerId = row[idCol] ? String(row[idCol]).trim() : '';
            const playerName = row[nameCol] ? String(row[nameCol]).trim() : '';
            const playerStatus = row[statusCol] ? String(row[statusCol]).trim() : '';
            const playerIsAdmin = row[isAdminCol] ? String(row[isAdminCol]).trim() : '';

            const publicPlayerInfo = { // Only public fields for all players
                Name: playerName,
                Status: playerStatus,
                IsAdmin: playerIsAdmin
            };
            allPublicPlayersData.push(publicPlayerInfo);

            // If a specific player is requested, build their full data object
            if (requestedPlayerId && currentPlayerId === requestedPlayerId) {
                requestedPlayerData = {
                    PlayerID: currentPlayerId, // Include PlayerID for the requested user
                    Name: playerName,
                    Status: playerStatus,
                    IsAdmin: playerIsAdmin
                };
                for (const field of sensitivePlayerFields) {
                    const colIndex = headers.indexOf(field);
                    if (colIndex !== -1) {
                        requestedPlayerData[field] = row[colIndex] !== undefined && row[colIndex] !== null ? String(row[colIndex]) : '';
                    } else {
                        console.warn(`get-player-data: Sensitive field '${field}' not found in headers for ${requestedPlayerId}.`);
                        requestedPlayerData[field] = '';
                    }
                }
            }
        }

        if (requestedPlayerId) {
            // If a specific player was requested, return only their full data
            if (requestedPlayerData) {
                console.log(`get-player-data: Returning full data for requested player: ${requestedPlayerId}`);
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestedPlayerData),
                };
            } else {
                console.log(`get-player-data: Requested player ${requestedPlayerId} not found.`);
                return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
            }
        } else {
            // If no specific player was requested, return public data for all players
            console.log(`get-player-data: Returning public data for ${allPublicPlayersData.length} players.`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allPublicPlayersData), // CRITICAL: Only public data
            };
        }

    } catch (error) {
        console.error('get-player-data: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player data.', details: error.message }),
        };
    } finally {
        console.log("get-player-data: Function finished.");
    }
};