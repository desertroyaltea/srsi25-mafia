// netlify/functions/authenticate-player.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Changed to full access for writing to Sessions
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
        passcodeInput = body.passcode;
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
            range: 'Players!A:C', // Fetch only PlayerID (A), Name (B), Passcode (C) for efficiency
        });

        const allPlayersData = playersResponse.data.values || [];
        if (allPlayersData.length < 2) { // At least headers + one player
            return { statusCode: 401, body: JSON.stringify({ error: 'No players registered.' }) };
        }

        const headers = allPlayersData[0];
        const playerRows = allPlayersData.slice(1);

        const playerIdCol = headers.indexOf('PlayerID');
        const passcodeCol = headers.indexOf('Passcode');

        if (playerIdCol === -1 || passcodeCol === -1) {
            console.error("authenticate-player: Required columns 'PlayerID' or 'Passcode' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'Passcode' not found in Players sheet.");
        }

        let authenticatedPlayerId = null;
        for (const row of playerRows) {
            const playerPasscode = row[passcodeCol] ? String(row[passcodeCol]).trim() : ''; // Ensure string and trim
            if (playerPasscode === passcodeInput.trim()) { // Compare trimmed passcodes
                authenticatedPlayerId = row[playerIdCol];
                break;
            }
        }

        if (authenticatedPlayerId) {

            // --- NEW: Log session to Sessions sheet ---
            const sessionId = `SESS_${Date.now()}_${authenticatedPlayerId}`;
            const loginTime = new Date().toISOString();
            const userAgent = event.headers['user-agent'] || 'Unknown';
            const ipAddress = event.headers['x-nf-client-connection-ip'] || 'Unknown'; // Netlify specific header for client IP

            const sessionEntry = [
                sessionId,
                authenticatedPlayerId,
                loginTime,
                loginTime, // LastActivityTime starts as LoginTime
                '',        // LogoutTime (empty initially)
                'Active',
                userAgent,
                ipAddress
            ];

            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'Sessions!A:H', // Assuming Sessions sheet has columns A to H
                valueInputOption: 'USER_ENTERED',
                resource: { values: [sessionEntry] },
            });
            // --- END NEW ---

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Authentication successful.', playerId: authenticatedPlayerId, sessionId: sessionId }), // Return sessionId
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