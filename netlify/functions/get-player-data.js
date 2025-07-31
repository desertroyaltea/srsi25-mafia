// netlify/functions/get-player-data.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
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

    const requestedPlayerId = event.queryStringParameters.playerId;
    console.log(`get-player-data: Requested Player ID: ${requestedPlayerId || 'None (fetching all public data)'}`);

    try {
        const sheets = await getSheetsService();
        console.log("get-player-data: Sheets service initialized.");

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AA', // Fetch all columns up to AA (Username)
        });

        const allPlayersRawData = playersResponse.data.values || [];
        if (allPlayersRawData.length < 1) {
            console.log("get-player-data: Players sheet is empty.");
            return { statusCode: 200, body: JSON.stringify([]) };
        }

        const headers = allPlayersRawData[0];
        const playerRows = allPlayersRawData.slice(1);

        const idCol = headers.indexOf('PlayerID');
        const nameCol = headers.indexOf('Name');
        const statusCol = headers.indexOf('Status');
        const isAdminCol = headers.indexOf('IsAdmin');
        const usernameCol = headers.indexOf('Username'); // Get Username column index

        if ([idCol, nameCol, statusCol, isAdminCol, usernameCol].includes(-1)) {
            console.error("get-player-data: Required public columns not found in Players sheet (PlayerID, Name, Status, IsAdmin, Username).");
            throw new Error("Required public columns not found in Players sheet.");
        }

        const sensitivePlayerFields = [
            'Passcode', 'Role', 'CurrentVotingPower', 'MissionsCompleted',
            'MafiaCanConvert', 'MafiaCanRevealSelf', 'VillagerCanIncreaseVote',
            'VillagerCanChangeRole', 'DoctorCanSaveMore', 'DoctorCanRevive',
            'DoctorCanRevealSelf', 'DetectiveCanRevealSelf', 'DoctorSavesRemaining',
            'SheriffShotUsed', 'IsJuryMember', 'OriginalRole', 'MainUsed',
            'InvestigationHistory', 'Jury', 'RevealedTeammates', 'NightVoteUsed', 'IsProtected', 'Welcome', 'PushSubscription'
        ];

        const allPlayersPublicAndID = []; // Store PlayerID, Name, Status, IsAdmin for all players
        let requestedPlayerData = null; // Store full data for the requested player

        for (const row of playerRows) {
            const currentPlayerId = row[idCol] ? String(row[idCol]).trim() : '';
            const playerName = row[nameCol] ? String(row[nameCol]).trim() : '';
            const playerStatus = row[statusCol] ? String(row[statusCol]).trim() : '';
            const playerIsAdmin = row[isAdminCol] ? String(row[isAdminCol]).trim() : '';
            const playerUsername = row[usernameCol] ? String(row[usernameCol]).trim() : '';

            const publicAndIdInfo = { // CRITICAL FIX: Include PlayerID for all players
                PlayerID: currentPlayerId,
                Name: playerName,
                Status: playerStatus,
                IsAdmin: playerIsAdmin
            };
            allPlayersPublicAndID.push(publicAndIdInfo);

            if (requestedPlayerId && currentPlayerId === requestedPlayerId) {
                requestedPlayerData = {
                    PlayerID: currentPlayerId,
                    Name: playerName,
                    Status: playerStatus,
                    IsAdmin: playerIsAdmin,
                    Username: playerUsername // Include Username for the requested user
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
            if (requestedPlayerData) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestedPlayerData),
                };
            } else {
                return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
            }
        } else {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allPlayersPublicAndID), // CRITICAL FIX: Return PlayerID, Name, Status, IsAdmin for all
            };
        }

    } catch (error) {
        console.error('get-player-data: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch player data.', details: error.message }),
        };
    } finally {
    }
};