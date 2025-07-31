// netlify/functions/send-push-notification.js

const webpush = require('web-push');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Configure web-push with your VAPID keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("send-push-notification: VAPID keys are not configured as environment variables.");
} else {
    webpush.setVapidDetails(
        'mailto:your_email@example.com', // REPLACE WITH YOUR ACTUAL EMAIL OR A GENERIC CONTACT
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

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
    if (event.httpMethod !== 'POST') {
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

    let targetPlayerId, title, body, icon = '', url = '';
    try {
        const eventBody = JSON.parse(event.body);
        targetPlayerId = eventBody.playerId;
        title = eventBody.title || 'SRSI Mafia Update';
        body = eventBody.body || 'A new event has occurred in the game.';
        icon = eventBody.icon || '';
        url = eventBody.url || 'https://your-game-url.netlify.app'; // URL to open on click
    } catch (e) {
        console.error("send-push-notification: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format.' }) };
    }

    if (!targetPlayerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Target Player ID is required.' }) };
    }

    try {
        const sheets = await getSheetsService();

        const playersResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Players!A:AB', // Fetch up to PushSubscription column
        });
        const playersData = playersResponse.data.values || [];
        if (playersData.length < 1) {
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
            if (String(row[idCol]).trim() === targetPlayerId) {
                try {
                    playerSubscription = JSON.parse(row[pushSubscriptionCol]);
                } catch (parseError) {
                    console.warn(`send-push-notification: Could not parse PushSubscription for ${targetPlayerId}: ${parseError.message}`);
                    playerSubscription = null;
                }
                break;
            }
        }

        if (!playerSubscription) {
            return { statusCode: 404, body: JSON.stringify({ message: `No valid PushSubscription found for player ${targetPlayerId}. Notification not sent.` }) };
        }

        // CRITICAL FIX: Declarative Web Push Payload Format
        const payload = JSON.stringify({
            "web_push": 8030, // Magic key for Declarative Web Push
            "notification": {
                "title": title,
                "body": body,
                "icon": icon,
                "navigate": url // URL to open when notification is clicked
            }
        });

        await webpush.sendNotification(playerSubscription, payload);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Push notification sent successfully!' }),
        };

    } catch (error) {
        console.error('send-push-notification: Error in try-catch block:', error);
        if (error.statusCode === 410) {
            console.warn(`send-push-notification: Subscription for ${targetPlayerId} is expired/gone. Consider removing it from sheet.`);
            return { statusCode: 200, body: JSON.stringify({ message: 'Notification failed: Subscription expired.', details: error.message }) };
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to send push notification.', details: error.message }),
        };
    } finally {
    }
};