// netlify/functions/send-push-notification.js

const webpush = require('web-push');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Configure web-push with your VAPID keys
// These are read from Netlify Environment Variables
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("send-push-notification: VAPID keys are not configured as environment variables.");
    // This will cause the function to fail if called without keys
} else {
    webpush.setVapidDetails(
        'mailto:alna7el2020@gmail.com', // Replace with your actual email or a generic contact
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
    console.log("send-push-notification: WebPush configured with VAPID details.");
}

async function getSheetsService() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only for fetching subscriptions
    });
    return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
    console.log("send-push-notification: Function started.");
    if (event.httpMethod !== 'POST') {
        console.log("send-push-notification: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.error("send-push-notification: VAPID keys missing, cannot send push notification.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: VAPID keys missing.' }) };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.error("send-push-notification: Google Sheet ID is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    let targetPlayerId, title, body, icon = ''; // Default icon
    try {
        const eventBody = JSON.parse(event.body);
        targetPlayerId = eventBody.playerId;
        title = eventBody.title || 'SRSI Mafia Update';
        body = eventBody.body || 'A new event has occurred in the game.';
        icon = eventBody.icon || ''; // Optional icon URL
    } catch (e) {
        console.error("send-push-notification: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!targetPlayerId) {
        console.log("send-push-notification: Missing targetPlayerId.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Target Player ID is required.' }) };
    }
    console.log(`send-push-notification: Preparing notification for ${targetPlayerId}: "${title}"`);

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AB', // Fetch up to PushSubscription column
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
            console.log("send-push-notification: Players sheet is empty.");
            return { statusCode: 404, body: JSON.stringify({ error: 'No players found to send notification.' }) };
        }
        const playerHeaders = playersData[0];
        const playerRows = playersData.slice(1);

        const idCol = playerHeaders.indexOf('PlayerID');
        const pushSubscriptionCol = playerHeaders.indexOf('PushSubscription');

        if (idCol === -1 || pushSubscriptionCol === -1) {
            console.error("send-push-notification: Required columns 'PlayerID' or 'PushSubscription' not found in Players sheet.");
            throw new Error("Required columns 'PlayerID' or 'PushSubscription' not found in Players sheet.");
        }

        let playerSubscription = null;
        for (const row of playerRows) {
            if (row[idCol] === targetPlayerId) {
                try {
                    playerSubscription = JSON.parse(row[pushSubscriptionCol]); // Parse the JSON string
                } catch (parseError) {
                    console.warn(`send-push-notification: Could not parse PushSubscription for ${targetPlayerId}: ${parseError.message}`);
                    playerSubscription = null;
                }
                break;
            }
        }

        if (!playerSubscription) {
            console.log(`send-push-notification: No valid PushSubscription found for player ${targetPlayerId}. Notification not sent.`);
            return { statusCode: 404, body: JSON.stringify({ message: `No valid push subscription found for ${targetPlayerId}.` }) };
        }

        const payload = JSON.stringify({
            title: title,
            body: body,
            icon: icon, // Optional icon
            data: {
                url: event.headers.referer || 'https://your-game-url.netlify.app', // Link to open when notification is clicked
            }
        });

        console.log(`send-push-notification: Sending push notification to ${targetPlayerId}.`);
        await webpush.sendNotification(playerSubscription, payload);
        console.log(`send-push-notification: Push notification sent successfully to ${targetPlayerId}.`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Push notification sent successfully!' }),
        };

    } catch (error) {
        console.error('send-push-notification: Error in try-catch block:', error);
        // Handle specific web-push errors (e.g., 410 Gone for expired subscriptions)
        if (error.statusCode === 410) {
            console.warn(`send-push-notification: Subscription for ${targetPlayerId} is expired/gone. Consider removing it from sheet.`);
            return { statusCode: 200, body: JSON.stringify({ message: 'Notification failed: Subscription expired.', details: error.message }) };
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to send push notification.', details: error.message }),
        };
    } finally {
        console.log("send-push-notification: Function finished.");
    }
};