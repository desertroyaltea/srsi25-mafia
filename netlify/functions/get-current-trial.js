// netlify/functions/get-current-trial.js

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
    console.log("get-current-trial: Function started.");
    if (event.httpMethod !== 'GET') {
        console.log("get-current-trial: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("get-current-trial: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }
    console.log(`get-current-trial: Sheet ID: ${sheetId}`);

    try {
        const sheets = await getSheetsService();
        console.log("get-current-trial: Sheets service initialized.");

        // CRITICAL FIX: Remove the Game_State fetch if LastAccusedPlayerID is not used by this function's core logic
        // The frontend fetches Game_State separately. This function's job is to find active trials.
        // const gameStateResponse = await sheets.spreadsheets.values.get({ ... });
        // const lastAccusedPlayerID = ...;

        // 1. Fetch all trials to find the ones with 'Active' status
        console.log("get-current-trial: Fetching all trials from 'Trials!A:H'.");
        const trialsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Trials!A:I', // Fetch up to Column I (NOTGUILTY)
        });

        const allTrials = trialsResponse.data.values || [];
        console.log(`get-current-trial: Fetched ${allTrials.length} rows from Trials sheet.`);

        if (allTrials.length < 2) {
            console.log("get-current-trial: Trials sheet is empty or has no data rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No trials data available.', activeTrials: [] }),
            };
        }

        const headers = allTrials[0];
        const trialRows = allTrials.slice(1);
        console.log("get-current-trial: Headers:", headers);
        console.log(`get-current-trial: Processing ${trialRows.length} trial data rows.`);

        const trialIdCol = headers.indexOf('TrialID');
        const accusedPlayerIdCol = headers.indexOf('AccusedPlayerID');
        const audioLinkCol = headers.indexOf('AccusationAudioLink');
        const trialStartTimeCol = headers.indexOf('TrialStartTime');
        const votingDeadlineCol = headers.indexOf('VotingDeadline');
        const statusCol = headers.indexOf('Status');
        const guiltyCol = headers.indexOf('GUILTY'); // Column H, index 7
        const notGuiltyCol = headers.indexOf('NOTGUILTY'); // Column I, index 8

        console.log(`get-current-trial: Column indices: TrialID=${trialIdCol}, AccusedPlayerID=${accusedPlayerIdCol}, AudioLink=${audioLinkCol}, Status=${statusCol}, Guilty=${guiltyCol}, NotGuilty=${notGuiltyCol}, TrialStartTime=${trialStartTimeCol}, VotingDeadline=${votingDeadlineCol}`);

        if ([trialIdCol, accusedPlayerIdCol, audioLinkCol, statusCol, guiltyCol, notGuiltyCol, trialStartTimeCol, votingDeadlineCol].includes(-1)) {
            console.error('get-current-trial: One or more required columns not found in Trials sheet. Check headers.');
            throw new Error('One or more required columns not found in Trials sheet.');
        }

        const activeTrials = [];
        for (let i = 0; i < trialRows.length; i++) {
            const trial = trialRows[i];
            const currentStatus = String(trial[statusCol]).trim(); // Ensure string and trim for comparison
            console.log(`get-current-trial: Checking row ${i + 2}. Status found: '${currentStatus}'. Expected: 'Active'`);

            if (currentStatus === 'Active') {
                console.log(`get-current-trial: Found active trial at row ${i + 2}.`);
                activeTrials.push({
                    TrialID: String(trial[trialIdCol]).trim(),
                    AccusedPlayerID: String(trial[accusedPlayerIdCol]).trim(),
                    AccusationAudioLink: String(trial[audioLinkCol]).trim(),
                    TrialStartTime: String(trial[trialStartTimeCol]).trim(),
                    VotingDeadline: String(trial[votingDeadlineCol]).trim(),
                    Status: String(trial[statusCol]).trim(),
                    GUILTY: parseInt(trial[guiltyCol] || '0'),
                    NOTGUILTY: parseInt(trial[notGuiltyCol] || '0'),
                    rowIndex: i + 2
                });
            }
        }

        if (activeTrials.length > 0) {
            console.log(`get-current-trial: Returning ${activeTrials.length} active trials.`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Active trials found.', activeTrials: activeTrials }),
            };
        } else {
            console.log("get-current-trial: No active trials found after checking all rows.");
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'No active trials found.', activeTrials: [] }),
            };
        }

    } catch (error) {
        console.error('get-current-trial: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch current trial data.', details: error.message }),
        };
    } finally {
        console.log("get-current-trial: Function finished.");
    }
};