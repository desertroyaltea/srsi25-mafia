// netlify/functions/reveal-mafia.js

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
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let mafiaPlayerId;
    try {
        const body = JSON.parse(event.body);
        mafiaPlayerId = body.mafiaPlayerId;
    } catch (e) {
        console.error("reveal-mafia: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!mafiaPlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing mafiaPlayerId.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Fetch all player data
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z', // Fetch a wide range to ensure all needed columns are read
        });

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const nameCol = playerHeaders.indexOf('Name');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const canRevealCol = playerHeaders.indexOf('MafiaCanRevealSelf');
        const revealedCol = playerHeaders.indexOf('RevealedTeammates');
        const isAdminCol = playerHeaders.indexOf('IsAdmin'); // Always include for authorization

        // CRITICAL FIX: Robust column existence check
        if ([idCol, nameCol, roleCol, statusCol, canRevealCol, revealedCol, isAdminCol].includes(-1)) {
            const missingCols = [];
            if (idCol === -1) missingCols.push('PlayerID');
            if (nameCol === -1) missingCols.push('Name');
            if (roleCol === -1) missingCols.push('Role');
            if (statusCol === -1) missingCols.push('Status');
            if (canRevealCol === -1) missingCols.push('MafiaCanRevealSelf');
            if (revealedCol === -1) missingCols.push('RevealedTeammates');
            if (isAdminCol === -1) missingCols.push('IsAdmin');

            console.error(`reveal-mafia: Missing required Player sheet columns: ${missingCols.join(', ')}.`);
            throw new Error(`Required columns not found in Players sheet: ${missingCols.join(', ')}.`);
        }

        // 2. Find the Mafia player, verify their ability, and get their current revealed list
        let mafiaPlayerRowIndex = -1;
        let alreadyRevealed = [];
        let mafiaRole = ''; // Get role for validation
        let mafiaCanRevealSelf = 'FALSE'; // Get actual ability status
        let mafiaIsAdmin = 'FALSE'; // Get admin status

        for (let i = 0; i < players.length; i++) {
            if (String(players[i][idCol]).trim() === mafiaPlayerId) {
                mafiaPlayerRowIndex = i + 2; // 1-based index for sheet ranges
                mafiaRole = String(players[i][roleCol]).trim();
                mafiaCanRevealSelf = String(players[i][canRevealCol]).trim();
                mafiaIsAdmin = String(players[i][isAdminCol]).trim();

                if (players[i][revealedCol]) {
                    alreadyRevealed = String(players[i][revealedCol]).split(',').map(s => s.trim());
                }
                break;
            }
        }

        if (mafiaPlayerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Mafia player not found or invalid ID.' }) };
        }
        if (mafiaRole !== 'Mafia') { // Check encrypted role
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Mafia can use this ability.' }) };
        }
        if (mafiaCanRevealSelf !== 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to reveal a teammate.' }) };
        }
        if (mafiaIsAdmin === 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot perform game actions.' }) };
        }

        // 3. Find all eligible teammates (Alive, Mafia, not self, not already revealed)
        const eligibleTeammates = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const playerId = String(player[idCol]).trim();
            const playerRole = String(player[roleCol]).trim();
            const playerStatus = String(player[statusCol]).trim();

            if (
                playerStatus === 'Alive' &&
                playerRole === 'Mafia' && // Check encrypted role
                playerId !== mafiaPlayerId &&
                !alreadyRevealed.includes(playerId)
            ) {
                eligibleTeammates.push({
                    id: playerId,
                    name: String(player[nameCol]).trim()
                });
            }
        }

        if (eligibleTeammates.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No new teammates to reveal.' }) };
        }

        // 4. Select a random teammate
        const randomTeammate = eligibleTeammates[Math.floor(Math.random() * eligibleTeammates.length)];

        // 5. Prepare batch update to add teammate to revealed list and remove ability
        const newRevealedList = [...alreadyRevealed, randomTeammate.id].join(',');

        const requests = [
            { // Update RevealedTeammates list
                range: `Players!${String.fromCharCode(65 + revealedCol)}${mafiaPlayerRowIndex}`,
                values: [[newRevealedList]]
            },
            { // Set MafiaCanRevealSelf ability to FALSE (one-time use)
                range: `Players!${String.fromCharCode(65 + canRevealCol)}${mafiaPlayerRowIndex}`,
                values: [['FALSE']]
            }
        ];

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `A fellow Mafia member has been revealed to you: ${randomTeammate.name}.`, revealedTeammateId: randomTeammate.id }),
        };

    } catch (error) {
        console.error('reveal-mafia: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to reveal teammate.', details: error.message }),
        };
    } finally {
    }
};