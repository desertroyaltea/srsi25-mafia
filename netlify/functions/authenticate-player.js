// netlify/functions/authenticate-player.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const bcrypt = require('bcryptjs'); // For hashing passcodes

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
        console.error("authenticate-player: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let usernameInput, passcodeInput; // CRITICAL FIX: Receive usernameInput
    try {
        const body = JSON.parse(event.body);
        usernameInput = body.username; // Get username
        passcodeInput = body.passcode;
    } catch (e) {
        console.error("authenticate-player: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!usernameInput || !passcodeInput) { // Validate both username and passcode
        return { statusCode: 400, body: JSON.stringify({ error: 'Username and Passcode are required.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // Fetch PlayerID (A), Username (AA), Passcode (C - assuming it shifted)
        // CRITICAL: Adjust range if Passcode column has shifted due to Username column insertion
        // Assuming your columns are now: A=PlayerID, B=Name, C=Passcode, D=Role, ..., AA=Username
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AA', // Fetch up to Username (AA) to get all needed columns
        });

        const allPlayersData = playersResponse.data.values || [];
        if (allPlayersData.length < 2) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No players registered.' }) };
        }

        const headers = allPlayersData[0];
        const playerRows = allPlayersData.slice(1);

        const playerIdCol = headers.indexOf('PlayerID');
        const usernameCol = headers.indexOf('Username'); // NEW: Get Username column index
        const passcodeCol = headers.indexOf('Passcode'); // Get Passcode column index

        if (playerIdCol === -1 || usernameCol === -1 || passcodeCol === -1) {
            console.error("authenticate-player: Required columns 'PlayerID', 'Username', or 'Passcode' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID', 'Username', or 'Passcode' not found in Players sheet.");
        }

        let authenticatedPlayerId = null;
        let foundUsername = null; // Store the username found for logging

        for (const row of playerRows) {
            const storedUsername = row[usernameCol] ? String(row[usernameCol]).trim() : '';
            const storedHashedPasscode = row[passcodeCol] ? String(row[passcodeCol]).trim() : '';
            
            // CRITICAL FIX: Authenticate by Username first, then verify Passcode
            if (storedUsername.toLowerCase() === usernameInput.trim().toLowerCase()) { // Case-insensitive username match
                foundUsername = storedUsername;
                let isMatch = false;
                if (storedHashedPasscode.startsWith('$2a$') || storedHashedPasscode.startsWith('$2b$')) {
                    isMatch = await bcrypt.compare(passcodeInput.trim(), storedHashedPasscode);
                } else {
                    console.warn("authenticate-player: Stored passcode is not in bcrypt hash format. Comparison skipped.");
                }

                if (isMatch) {
                    authenticatedPlayerId = row[playerIdCol]; // Get the numeric PlayerID
                    break;
                }
            }
        }

        if (authenticatedPlayerId) {
            const sessionId = `SESS_${Date.now()}_${authenticatedPlayerId}`;
            const loginTime = new Date().toISOString();
            const userAgent = event.headers['user-agent'] || 'Unknown';
            const ipAddress = event.headers['x-nf-client-connection-ip'] || 'Unknown';

            const sessionEntry = [
                sessionId,
                authenticatedPlayerId, // Log numeric PlayerID
                loginTime,
                loginTime,
                '',
                'Active',
                userAgent,
                ipAddress
            ];

            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'Sessions!A:H',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [sessionEntry] },
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Authentication successful.', playerId: authenticatedPlayerId, sessionId: sessionId }), // Return numeric PlayerID
            };
        } else {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid Username or Passcode.' }) }; // Generic error
        }

    } catch (error) {
        console.error('authenticate-player: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Authentication failed.', details: error.message }),
        };
    } finally {
    }
};