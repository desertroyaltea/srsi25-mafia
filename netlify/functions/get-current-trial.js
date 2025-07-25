// netlify/functions/get-current-trial.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only scope is sufficient for this function
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("get-current-trial: Function started."); // LOG 1
    if (event.httpMethod !== 'GET') {
        console.log("get-current-trial: Method not allowed."); // LOG 2
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-current-trial: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`get-current-trial: Sheet ID: ${sheetId}`); // LOG 3

    try {
        const sheets = await getSheetsService();
        console.log("get-current-trial: Sheets service initialized."); // LOG 4

        // 1. Get LastAccusedPlayerID from Game_State sheet (this part is actually not strictly needed for finding *any* active trial, but keeping for context)
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!E2', // Assuming E2 contains LastAccusedPlayerID
        });
        const lastAccusedPlayerID = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : null;
        console.log(`get-current-trial: LastAccusedPlayerID from Game_State: ${lastAccusedPlayerID}`); // LOG 5

        // The frontend logic should check if a trial is found, this function's primary job is to find an 'Active' one.
        // The previous check for lastAccusedPlayerID here was causing the "No active trial found" message prematurely
        // if Game_State!E2 was empty/N/A, even if an 'Active' trial existed.
        // Let's remove this early return here to allow the function to search for 'Active' trials regardless.
        // If the frontend needs to know about lastAccusedPlayerID, it should fetch Game_State separately.

        // 2. Fetch all trials to find the one with 'Active' status
        console.log("get-current-trial: Fetching all trials from 'Trials!A:H'."); // LOG 6
        const trialsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Trials!A:H', // Fetch all relevant columns
        });

        const allTrials = trialsResponse.data.values || [];
        console.log(`get-current-trial: Fetched ${allTrials.length} rows from Trials sheet.`); // LOG 7

        if (allTrials.length < 2) { // Less than 2 means only headers or no data
            console.log("get-current-trial: Trials sheet is empty or has no data rows."); // LOG 8
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No trials data available.', currentTrial: null }),
            };
        }

        const headers = allTrials[0];
        const trialRows = allTrials.slice(1);
        console.log("get-current-trial: Headers:", headers); // LOG 9
        console.log(`get-current-trial: Processing ${trialRows.length} trial data rows.`); // LOG 10

        const trialIdCol = headers.indexOf('TrialID');
        const accusedPlayerIdCol = headers.indexOf('AccusedPlayerID');
        const audioLinkCol = headers.indexOf('AccusationAudioLink');
        const trialStartTimeCol = headers.indexOf('TrialStartTime'); // Added for completeness
        const votingDeadlineCol = headers.indexOf('VotingDeadline'); // Added for completeness
        const statusCol = headers.indexOf('Status');
        const guiltyCol = headers.indexOf('GUILTY');
        const notGuiltyCol = headers.indexOf('NOTGUILTY');

        console.log(`get-current-trial: Column indices: TrialID=${trialIdCol}, AccusedPlayerID=${accusedPlayerIdCol}, AudioLink=${audioLinkCol}, Status=${statusCol}, Guilty=${guiltyCol}, NotGuilty=${notGuiltyCol}`); // LOG 11

        if ([trialIdCol, accusedPlayerIdCol, audioLinkCol, statusCol, guiltyCol, notGuiltyCol, trialStartTimeCol, votingDeadlineCol].includes(-1)) {
            console.error('get-current-trial: One or more required columns not found in Trials sheet. Check headers.'); // LOG 12
            throw new Error('One or more required columns not found in Trials sheet.');
        }

        let currentTrialData = null;
        for (let i = 0; i < trialRows.length; i++) {
            const trial = trialRows[i];
            const currentStatus = trial[statusCol];
            console.log(`get-current-trial: Checking row ${i + 2}. Status found: '${currentStatus}'. Expected: 'Active'`); // LOG 13

            if (currentStatus === 'Active') { // CRITICAL: Looking for 'Active' status
                console.log(`get-current-trial: Found active trial at row ${i + 2}.`); // LOG 14
                currentTrialData = {
                    TrialID: trial[trialIdCol],
                    AccusedPlayerID: trial[accusedPlayerIdCol],
                    AccusationAudioLink: trial[audioLinkCol],
                    TrialStartTime: trial[trialStartTimeCol],
                    VotingDeadline: trial[votingDeadlineCol],
                    Status: trial[statusCol],
                    GUILTY: parseInt(trial[guiltyCol] || '0'),
                    NOTGUILTY: parseInt(trial[notGuiltyCol] || '0'),
                    rowIndex: i + 2 // Store original row index for potential updates later
                };
                break; // Stop after finding the first active trial
            }
        }

        if (currentTrialData) {
            console.log("get-current-trial: Returning active trial data:", currentTrialData); // LOG 15
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Active trial found.', currentTrial: currentTrialData }),
            };
        } else {
            console.log("get-current-trial: No active trial found after checking all rows."); // LOG 16
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No active trial found.', currentTrial: null }),
            };
        }

    } catch (error) {
        console.error('get-current-trial: Error in try-catch block:', error); // LOG 17
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch current trial data.', details: error.message }),
        };
    }
};