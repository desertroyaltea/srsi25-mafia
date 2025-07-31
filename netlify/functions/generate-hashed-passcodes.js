// netlify/functions/generate-hashed-passcodes.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const bcrypt = require('bcryptjs'); // For hashing passcodes

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Full access for writing to Players sheet
    });
    return google.sheets({ version: 'v4', auth });
}

// Helper to generate a single plain-text passcode
function generateSinglePasscode() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let passcode = '';
    passcode += letters.charAt(Math.floor(Math.random() * letters.length));
    passcode += letters.charAt(Math.floor(Math.random() * letters.length));
    passcode += Math.floor(Math.random() * 10);
    passcode += Math.floor(Math.random() * 10);
    passcode += Math.floor(Math.random() * 10);
    return passcode;
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("generate-hashed-passcodes: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Fetch current PlayerIDs and Names from the Players sheet
        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:C', // Fetch PlayerID (A), Name (B), Passcode (C)
        });

        const allPlayersData = playersResponse.data.values || [];
        if (allPlayersData.length < 2) {
            console.log("generate-hashed-passcodes: Players sheet is empty or has no player data.");
            return { statusCode: 400, body: JSON.stringify({ error: 'No players found in sheet.' }) };
        }

        const playerHeaders = allPlayersData[0];
        const playerRows = allPlayersData.slice(1);

        const playerIdCol = playerHeaders.indexOf('PlayerID');
        const nameCol = playerHeaders.indexOf('Name');
        const passcodeCol = playerHeaders.indexOf('Passcode');

        if (playerIdCol === -1 || nameCol === -1 || passcodeCol === -1) {
            console.error("generate-hashed-passcodes: Required columns 'PlayerID', 'Name', or 'Passcode' not found.");
            throw new Error("Required columns 'PlayerID', 'Name', or 'Passcode' not found in Players sheet.");
        }

        const generatedPlainPasscodes = new Set(); // To ensure uniqueness of plain-text passcodes
        const plainPasscodeOutputs = []; // To return to Apps Script for distribution
        const playerUpdates = []; // To update the Players sheet with hashed passcodes

        for (let i = 0; i < playerRows.length; i++) {
            const playerID = String(playerRows[i][playerIdCol]).trim();
            const playerName = String(playerRows[i][nameCol]).trim();
            let plainPasscode = '';
            let hashedPasscode = '';
            let attempts = 0;

            // Generate unique plain-text passcode
            do {
                plainPasscode = generateSinglePasscode();
                attempts++;
                if (attempts > 1000) { // Safety break
                    console.warn(`generate-hashed-passcodes: Failed to generate unique plain-text passcode for ${playerID} after many attempts.`);
                    plainPasscode = `ERROR_${Date.now()}`;
                    break;
                }
            } while (generatedPlainPasscodes.has(plainPasscode));

            generatedPlainPasscodes.add(plainPasscode);
            
            // Hash the passcode using bcrypt
            const saltRounds = 10; // Standard work factor for bcrypt
            hashedPasscode = await bcrypt.hash(plainPasscode, saltRounds);

            // Collect plain-text passcode for output
            plainPasscodeOutputs.push({ PlayerID: playerID, PlayerName: playerName, Passcode: plainPasscode });

            // Prepare update for Players sheet (hashed passcode)
            playerUpdates.push({
                range: `Players!${String.fromCharCode(65 + passcodeCol)}${i + 2}`, // Column C, row i+2
                values: [[hashedPasscode]]
            });
        }

        // 2. Batch update Players sheet with hashed passcodes
        if (playerUpdates.length > 0) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data: playerUpdates
                }
            });
            console.log(`generate-hashed-passcodes: Updated hashed passcodes for ${playerUpdates.length} players.`);
        } else {
            console.log('generate-hashed-passcodes: No player passcodes to update.');
        }

        // Return plain-text passcodes for Apps Script to write to PlainPasscodes sheet
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Passcodes generated and hashed successfully.', plainPasscodes: plainPasscodeOutputs }),
        };

    } catch (error) {
        console.error('generate-hashed-passcodes: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to generate and hash passcodes.', details: error.message }),
        };
    } finally {
        console.log("generate-hashed-passcodes: Function finished.");
    }
};