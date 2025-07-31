// netlify/functions/authenticate-player.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const bcrypt = require('bcryptjs'); // Ensure this is installed via npm install bcryptjs

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

    let passcodeInput;
    try {
        const body = JSON.parse(event.body);
        passcodeInput = body.passcode; // This is the plain-text passcode entered by the user
    } catch (e) {
        console.error("authenticate-player: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!passcodeInput) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Passcode is required.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:C', // Fetch PlayerID (A), Name (B), Passcode (C)
        });

        const allPlayersData = playersResponse.data.values || [];
        if (allPlayersData.length < 2) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No players registered.' }) };
        }

        const headers = allPlayersData[0];
        const playerRows = allPlayersData.slice(1);

        const playerIdCol = headers.indexOf('PlayerID');
        const passcodeCol = headers.indexOf('Passcode'); // This column contains the HASHED passcode

        if (playerIdCol === -1 || passcodeCol === -1) {
            console.error("authenticate-player: Required columns 'PlayerID' or 'Passcode' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'Passcode' not found in Players sheet.");
        }

        let authenticatedPlayerId = null;
        for (const row of playerRows) {
            const storedHashedPasscode = row[passcodeCol] ? String(row[passcodeCol]).trim() : ''; // This is the HASHED string from the sheet
            
            // CRITICAL FIX: Use bcrypt.compare to compare plain-text input against the stored hash
            // If storedHashedPasscode is empty or not a valid hash, bcrypt.compare might throw or return false.
            // We need to ensure it's a valid hash format for bcrypt.
            let isMatch = false;
            if (storedHashedPasscode.startsWith('$2a$') || storedHashedPasscode.startsWith('$2b$')) { // Check for bcrypt hash format
                 isMatch = await bcrypt.compare(passcodeInput.trim(), storedHashedPasscode);
            } else {
                // If it's not a bcrypt hash (e.g., it's a plain-text passcode from before hashing was implemented)
                // This branch should ideally not be hit once all passcodes are hashed.
                // For robust migration, you might compare plain-text here too, but for security,
                // we assume all stored passcodes are now hashed.
                console.warn("authenticate-player: Stored passcode is not in bcrypt hash format. Comparison skipped.");
            }

            if (isMatch) {
                authenticatedPlayerId = row[playerIdCol];
                break;
            }
        }

        if (authenticatedPlayerId) {
            const sessionId = `SESS_${Date.now()}_${authenticatedPlayerId}`;
            const loginTime = new Date().toISOString();
            const userAgent = event.headers['user-agent'] || 'Unknown';
            const ipAddress = event.headers['x-nf-client-connection-ip'] || 'Unknown';

            const sessionEntry = [
                sessionId,
                authenticatedPlayerId,
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
                body: JSON.stringify({ message: 'Authentication successful.', playerId: authenticatedPlayerId, sessionId: sessionId }),
            };
        } else {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid Passcode.' }) };
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