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
        if (idCol === -1) {
            console.error("get-player-data: 'PlayerID' column not found in Players sheet headers.");
            throw new Error("Required column 'PlayerID' not found in Players sheet.");
        }

        const publicPlayerFields = ['PlayerID', 'Name', 'Status', 'IsAdmin']; // Fields always sent publicly
        const sensitivePlayerFields = [ // Fields only sent for the requested player
            'Passcode', 'Role', 'CurrentVotingPower', 'MissionsCompleted',
            'MafiaCanConvert', 'MafiaCanRevealSelf', 'VillagerCanIncreaseVote',
            'VillagerCanChangeRole', 'DoctorCanSaveMore', 'DoctorCanRevive',
            'DoctorCanRevealSelf', 'DetectiveCanRevealSelf', 'DoctorSavesRemaining',
            'SheriffShotUsed', 'IsJuryMember', 'OriginalRole', 'MainUsed',
            'InvestigationHistory', 'Jury', 'RevealedTeammates', 'NightVoteUsed', 'IsProtected', 'Welcome'
        ];

        const allPlayers = [];
        let requestedPlayerData = null;

        for (const row of playerRows) {
            const player = {};
            const currentPlayerId = row[idCol];

            // Populate public fields for all players
            for (const field of publicPlayerFields) {
                const colIndex = headers.indexOf(field);
                if (colIndex !== -1) {
                    player[field] = row[colIndex] !== undefined && row[colIndex] !== null ? String(row[colIndex]) : '';
                } else {
                    console.warn(`get-player-data: Public field '${field}' not found in headers.`);
                    player[field] = ''; // Default empty if not found
                }
            }

            // If a specific player is requested, fill in their sensitive data
            if (requestedPlayerId && currentPlayerId === requestedPlayerId) {
                for (const field of sensitivePlayerFields) {
                    const colIndex = headers.indexOf(field);
                    if (colIndex !== -1) {
                        player[field] = row[colIndex] !== undefined && row[colIndex] !== null ? String(row[colIndex]) : '';
                    } else {
                        console.warn(`get-player-data: Sensitive field '${field}' not found in headers for ${requestedPlayerId}.`);
                        player[field] = ''; // Default empty if not found
                    }
                }
                requestedPlayerData = player; // Store the full data for the requested player
            }
            allPlayers.push(player);
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
            console.log(`get-player-data: Returning public data for ${allPlayers.length} players.`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allPlayers),
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