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

    // NEW: Parameters for fetching sensitive data
    const requestedPlayerId = event.queryStringParameters.playerId; // Still used for public lookup
    const requestedUsername = event.queryStringParameters.username; // NEW: For sensitive lookup
    const sessionId = event.queryStringParameters.sessionId; // NEW: For sensitive lookup authorization

    console.log(`get-player-data: Requested PlayerId: ${requestedPlayerId || 'N/A'}, Username: ${requestedUsername || 'N/A'}, SessionId: ${sessionId || 'N/A'}`);

    try {
        const sheets = await getSheetsService();

        // Fetch all player data (including sensitive fields for server-side processing)
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
        const usernameCol = headers.indexOf('Username'); // Column AA, index 26
        const passcodeCol = headers.indexOf('Passcode'); // Column C

        // Validate critical headers
        if ([idCol, nameCol, statusCol, isAdminCol, usernameCol, passcodeCol].includes(-1)) {
            console.error("get-player-data: One or more critical columns not found in Players sheet.");
            throw new Error("Required columns (PlayerID, Name, Status, IsAdmin, Username, Passcode) not found in Players sheet.");
        }

        const sensitivePlayerFields = [ // Fields that are sensitive
            'Passcode', 'Role', 'CurrentVotingPower', 'MissionsCompleted',
            'MafiaCanConvert', 'MafiaCanRevealSelf', 'VillagerCanIncreaseVote',
            'VillagerCanChangeRole', 'DoctorCanSaveMore', 'DoctorCanRevive',
            'DoctorCanRevealSelf', 'DetectiveCanRevealSelf', 'DoctorSavesRemaining',
            'SheriffShotUsed', 'IsJuryMember', 'OriginalRole', 'MainUsed',
            'InvestigationHistory', 'Jury', 'RevealedTeammates', 'NightVoteUsed', 'IsProtected', 'Welcome', 'PushSubscription'
        ];

        // --- SCENARIO 1: Fetch Full Sensitive Profile (Requires Authorization) ---
        if (requestedUsername && sessionId) {
            console.log(`get-player-data: Attempting to fetch full profile for Username: ${requestedUsername} with Session: ${sessionId}`);

            // Step 1: Authorize the session ID
            const authResponse = await fetch('https://' + event.headers.host + '/.netlify/functions/authorize-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId }),
            });
            const authResult = await authResponse.json();

            if (!authResponse.ok || !authResult.authorizedPlayerId) {
                console.warn(`get-player-data: Unauthorized session for username fetch. Session ID: ${sessionId}`);
                return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid session.' }) };
            }

            // Step 2: Find the player by the *requested Username* (which should match the authorized session's user)
            let foundPlayerByUsername = null;
            for (const row of playerRows) {
                const currentPlayerId = String(row[idCol]).trim();
                const currentUsername = String(row[usernameCol]).trim();
                
                if (currentUsername.toLowerCase() === requestedUsername.toLowerCase()) { // Match username (case-insensitive)
                    // CRITICAL: Ensure the PlayerID linked to this username matches the authorized session ID
                    if (currentPlayerId === authResult.authorizedPlayerId) {
                        foundPlayerByUsername = {
                            PlayerID: currentPlayerId,
                            Name: String(row[nameCol]).trim(),
                            Status: String(row[statusCol]).trim(),
                            IsAdmin: String(row[isAdminCol]).trim(),
                            Username: currentUsername // Include Username for the requested user
                        };
                        for (const field of sensitivePlayerFields) {
                            const colIndex = headers.indexOf(field);
                            if (colIndex !== -1) {
                                foundPlayerByUsername[field] = row[colIndex] !== undefined && row[colIndex] !== null ? String(row[colIndex]) : '';
                            } else {
                                console.warn(`get-player-data: Sensitive field '${field}' not found for ${requestedUsername}.`);
                                foundPlayerByUsername[field] = '';
                            }
                        }
                        break;
                    } else {
                        // This case means the user provided a correct username for someone else's player ID, but is not authenticated as them.
                        // Or they are trying to fetch sensitive data for a username they know, but are logged in as a different PlayerID.
                        console.warn(`get-player-data: Username ${requestedUsername} found, but PlayerID ${currentPlayerId} does not match authorized session ${authResult.authorizedPlayerId}.`);
                        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: Username does not match authenticated user.' }) };
                    }
                }
            }

            if (foundPlayerByUsername) {
                console.log(`get-player-data: Returning full sensitive data for Username: ${requestedUsername}`);
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(foundPlayerByUsername),
                };
            } else {
                console.log(`get-player-data: Username ${requestedUsername} not found.`);
                return { statusCode: 404, body: JSON.stringify({ error: 'Player not found with that username.' }) };
            }
        }
        // --- END SCENARIO 1 ---

        // --- SCENARIO 2: Fetch Public Data for ALL Players (No sensitive data) ---
        // This is the default if no specific Username/Session is provided.
        // It also handles abuse attempts (playerId provided without sessionId/username).
        if (!requestedPlayerId && !requestedUsername && !sessionId) {
            const allPlayersPublicData = [];
            for (const row of playerRows) {
                const playerName = String(row[nameCol]).trim();
                const playerStatus = String(row[statusCol]).trim();
                const playerIsAdmin = String(row[isAdminCol]).trim();
                const currentPlayerId = String(row[idCol]).trim(); // Include PlayerID for public list

                allPlayersPublicData.push({
                    PlayerID: currentPlayerId, // Include PlayerID for public list
                    Name: playerName,
                    Status: playerStatus,
                    IsAdmin: playerIsAdmin
                });
            }
            console.log(`get-player-data: Returning public data with PlayerIDs for ${allPlayersPublicData.length} players.`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allPlayersPublicData),
            };
        }
        // --- END SCENARIO 2 ---

        // --- SCENARIO 3: Fetch Public Data for a Specific PlayerID (Abuse Attempt / Link Sharing) ---
        // This handles cases where someone tries to use a publicly known PlayerID to get sensitive data without authentication.
        if (requestedPlayerId && !requestedUsername && !sessionId) {
            console.log(`get-player-data: Attempting to fetch public data for specific PlayerID: ${requestedPlayerId}`);
            let publicPlayerProfile = null;
            for (const row of playerRows) {
                if (String(row[idCol]).trim() === requestedPlayerId) {
                    publicPlayerProfile = {
                        PlayerID: String(row[idCol]).trim(),
                        Name: String(row[nameCol]).trim(),
                        Status: String(row[statusCol]).trim(),
                        IsAdmin: String(row[isAdminCol]).trim()
                    };
                    break;
                }
            }
            if (publicPlayerProfile) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(publicPlayerProfile),
                };
            } else {
                return { statusCode: 404, body: JSON.stringify({ error: 'Player not found (public data only).' }) };
            }
        }
        // --- END SCENARIO 3 ---

        // Catch-all for unhandled / invalid requests
        console.warn("get-player-data: Unhandled request scenario. Returning bad request.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or incomplete request parameters.' }) };


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