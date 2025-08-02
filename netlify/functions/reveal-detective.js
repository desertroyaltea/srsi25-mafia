// netlify/functions/reveal-detective.js

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

    let detectivePlayerId;
    try {
        const body = JSON.parse(event.body);
        detectivePlayerId = body.detectivePlayerId;
    } catch (e) {
        console.error("reveal-detective: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!detectivePlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing detectivePlayerId.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Fetch all player data
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:Z',
        });

        const playerHeaders = playersResponse.data.values[0];
        const players = playersResponse.data.values.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const nameCol = playerHeaders.indexOf('Name');
        const roleCol = playerHeaders.indexOf('Role');
        const statusCol = playerHeaders.indexOf('Status');
        const canRevealCol = playerHeaders.indexOf('DetectiveCanRevealSelf'); // Changed for Detective
        const revealedCol = playerHeaders.indexOf('RevealedTeammates');
        const isAdminCol = playerHeaders.indexOf('IsAdmin');

        if ([idCol, nameCol, roleCol, statusCol, canRevealCol, revealedCol, isAdminCol].includes(-1)) {
            // Build a list of missing columns for a clear error message
            const missingCols = [];
            if (idCol === -1) missingCols.push('PlayerID');
            if (nameCol === -1) missingCols.push('Name');
            if (roleCol === -1) missingCols.push('Role');
            if (statusCol === -1) missingCols.push('Status');
            if (canRevealCol === -1) missingCols.push('DetectiveCanRevealSelf');
            if (revealedCol === -1) missingCols.push('RevealedTeammates');
            if (isAdminCol === -1) missingCols.push('IsAdmin');
            
            console.error(`reveal-detective: Missing required Player sheet columns: ${missingCols.join(', ')}.`);
            throw new Error(`Required columns not found in Players sheet: ${missingCols.join(', ')}.`);
        }

        // 2. Find the Detective player and verify their ability
        let detectivePlayerRowIndex = -1;
        let alreadyRevealed = [];
        let detectiveRole = '';
        let detectiveCanRevealSelf = 'FALSE';

        for (let i = 0; i < players.length; i++) {
            if (String(players[i][idCol]).trim() === detectivePlayerId) {
                detectivePlayerRowIndex = i + 2;
                detectiveRole = String(players[i][roleCol]).trim();
                detectiveCanRevealSelf = String(players[i][canRevealCol]).trim();

                if (players[i][revealedCol]) {
                    alreadyRevealed = String(players[i][revealedCol]).split(',').map(s => s.trim());
                }
                break;
            }
        }

        if (detectivePlayerRowIndex < 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Detective player not found.' }) };
        }
        if (detectiveRole !== 'Detective') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Only Detectives can use this ability.' }) };
        }
        if (detectiveCanRevealSelf !== 'TRUE') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have the ability to reveal a teammate.' }) };
        }

        // 3. Find all eligible teammates (Alive, Detective, not self, not already revealed)
        const eligibleTeammates = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const playerId = String(player[idCol]).trim();
            const playerRole = String(player[roleCol]).trim();
            const playerStatus = String(player[statusCol]).trim();

            if (
                playerStatus === 'Alive' &&
                playerRole === 'Detective' &&
                playerId !== detectivePlayerId &&
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

        // 5. Prepare batch update
        const newRevealedList = [...alreadyRevealed, randomTeammate.id].join(',');

        const requests = [
            {
                range: `Players!${String.fromCharCode(65 + revealedCol)}${detectivePlayerRowIndex}`,
                values: [[newRevealedList]]
            },
            {
                range: `Players!${String.fromCharCode(65 + canRevealCol)}${detectivePlayerRowIndex}`,
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
            body: JSON.stringify({ "message": `A fellow Detective has been revealed to you: ${randomTeammate.name}.`, revealedTeammateId: randomTeammate.id }),
        };

    } catch (error) {
        console.error('reveal-detective: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to reveal teammate.', details: error.message }),
        };
    }
};
