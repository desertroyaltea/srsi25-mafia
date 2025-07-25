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
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-current-trial: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const sheets = await getSheetsService();

        // 1. Get LastAccusedPlayerID from Game_State sheet
        const gameStateResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Game_State!E2', // Assuming E2 contains LastAccusedPlayerID
        });
        const lastAccusedPlayerID = gameStateResponse.data.values && gameStateResponse.data.values[0] ? gameStateResponse.data.values[0][0] : null;

        if (!lastAccusedPlayerID || lastAccusedPlayerID === 'N/A') { // Check for 'N/A' as well
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No active trial found.', currentTrial: null }),
            };
        }

        // 2. Fetch all trials to find the one related to the lastAccusedPlayerID and 'Ongoing' status
        const trialsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Trials!A:H', // Fetch all relevant columns
        });

        const allTrials = trialsResponse.data.values || [];
        if (allTrials.length < 2) { // Less than 2 means only headers or no data
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No trials data available.', currentTrial: null }),
            };
        }

        const headers = allTrials[0];
        const trialRows = allTrials.slice(1);

        const trialIdCol = headers.indexOf('TrialID');
        const accusedPlayerIdCol = headers.indexOf('AccusedPlayerID');
        const audioLinkCol = headers.indexOf('AccusationAudioLink');
        const statusCol = headers.indexOf('Status');
        const guiltyCol = headers.indexOf('GUILTY');
        const notGuiltyCol = headers.indexOf('NOTGUILTY');

        if ([trialIdCol, accusedPlayerIdCol, audioLinkCol, statusCol, guiltyCol, notGuiltyCol].includes(-1)) {
            throw new Error('One or more required columns not found in Trials sheet.');
        }

        let currentTrialData = null;
        for (let i = 0; i < trialRows.length; i++) {
            const trial = trialRows[i];
// Find the trial that has 'Active' status
            if (trial[statusCol] === 'Active') { // CRITICAL CHANGE: Looking for 'Active' status
                currentTrialData = {
                    TrialID: trial[trialIdCol],
                    AccusedPlayerID: trial[accusedPlayerIdCol],
                    AccusationAudioLink: trial[audioLinkCol],
                    TrialStartTime: trial[headers.indexOf('TrialStartTime')], // Include TrialStartTime
                    VotingDeadline: trial[headers.indexOf('VotingDeadline')], // Include VotingDeadline
                    Status: trial[statusCol],
                    GUILTY: parseInt(trial[guiltyCol] || '0'),
                    NOTGUILTY: parseInt(trial[notGuiltyCol] || '0'),
                    rowIndex: i + 2 // Store original row index for potential updates later
                };
                break;
            }            
        }

        if (currentTrialData) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Active trial found.', currentTrial: currentTrialData }),
            };
        } else {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No ongoing trial for the last accused player.', currentTrial: null }),
            };
        }

    } catch (error) {
        console.error('Error fetching current trial:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch current trial data.', details: error.message }),
        };
    }
};