// netlify/functions/save-push-subscription.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Full access for writing
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("save-push-subscription: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("save-push-subscription: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("save-push-subscription: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let playerId, subscription;
    try {
        const body = JSON.parse(event.body);
        playerId = body.playerId;
        subscription = body.subscription;
    } catch (e) {
        console.error("save-push-subscription: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!playerId || !subscription) {
        console.log("save-push-subscription: Missing playerId or subscription.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing playerId or subscription.' }) };
    }
    console.log(`save-push-subscription: Saving subscription for player: ${playerId}`);

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AB', // Fetch up to Column AB (assuming PushSubscription is there)
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.error("save-push-subscription: Players sheet is empty.");
            return { statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const pushSubscriptionCol = playerHeaders.indexOf('PushSubscription'); // Column AB, index 27 (0-indexed)

        if (idCol === -1 || pushSubscriptionCol === -1) {
            console.error("save-push-subscription: Required columns 'PlayerID' or 'PushSubscription' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'PushSubscription' not found in Players sheet.");
        }

        let playerRowIndex = -1;
        for(let i = 0; i < playerRows.length; i++) {
            if(playerRows[i][idCol] === playerId) {
                playerRowIndex = i + 2; // +2 for 0-index and header row
                break;
            }
        }

        if (playerRowIndex === -1) {
            console.log("save-push-subscription: Player not found in sheet.");
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }

        // Store the subscription as a JSON string
        const subscriptionJson = JSON.stringify(subscription);

        const updateRange = `Players!${String.fromCharCode(65 + pushSubscriptionCol)}${playerRowIndex}`;
        console.log(`save-push-subscription: Updating PushSubscription for ${playerId} at range: ${updateRange}`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[subscriptionJson]] },
        });
        console.log(`save-push-subscription: PushSubscription saved for ${playerId}.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Push subscription saved successfully!' }),
        };

    } catch (error) {
        console.error('save-push-subscription: Error in try-catch block:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to save push subscription.', details: error.message }),
        };
    } finally {
        console.log("save-push-subscription: Function finished.");
    }
};