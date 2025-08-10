// File: netlify/functions/upload-kill-video.js

const { google } = require('googleapis');
const busboy = require('busboy');
const stream = require('stream');

// --- NEW OAUTH2 AUTHENTICATION HELPER ---
async function getAuthenticatedClient(scopes) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        throw new Error("Missing Google OAuth credentials in environment variables.");
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        "https://developers.google.com/oauthplayground" // Standard redirect URI for this method
    );

    oauth2Client.setCredentials({
        refresh_token: GOOGLE_REFRESH_TOKEN,
    });

    // The client will automatically use the refresh token to get a new access token.
    return oauth2Client;
}


// --- Google Sheets API Helper (You should move this to a shared file later) ---
async function getSheetData(auth, range) {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: range,
    });
    return response.data.values || [];
}

async function updateSheetData(auth, range, values) {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] },
    });
}

async function appendSheetData(auth, range, values) {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] },
    });
}
// --- End Google Sheets API Helper ---


// Helper to parse multipart form data from Netlify's event
function parseMultipartForm(event) {
    return new Promise((resolve) => {
        const fields = {};
        const files = {};

        const bb = busboy({
            headers: {
                'content-type': event.headers['content-type'] || event.headers['Content-Type']
            }
        });

        bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
            const buffer = [];
            file.on('data', (data) => buffer.push(data));
            file.on('end', () => {
                files[fieldname] = {
                    content: Buffer.concat(buffer),
                    filename: filename.filename,
                    contentType: mimetype,
                };
            });
        });

        bb.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        bb.on('close', () => {
            resolve({ fields, files });
        });

        bb.end(Buffer.from(event.body, 'base64'));
    });
}


exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { fields, files } = await parseMultipartForm(event);
        const { playerId } = fields;
        const videoFile = files.videoFile;

        if (!playerId || !videoFile) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: playerId or videoFile.' }) };
        }

        // --- Authenticate using OAuth2 for both Sheets and Drive ---
        const auth = await getAuthenticatedClient([
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive'
        ]);

        // --- Get Player Info ---
        const playersData = await getSheetData(auth, 'Players!A:F');
        const playerRow = playersData.find(row => row[0] === playerId);

        if (!playerRow) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }
        
        const playerName = playerRow[1]; // Assuming Name is in column B
        const playerRowIndex = playersData.findIndex(row => row[0] === playerId) + 1;

        // --- Upload to Google Drive ---
        const drive = google.drive({ version: 'v3', auth: auth }); // Use the same OAuth client

        const timestamp = new Date().toISOString();
        // Use a more robust filename to avoid issues with special characters
        const safePlayerName = playerName.replace(/[^a-zA-Z0-9]/g, '_');
        const newFileName = `${timestamp}_${safePlayerName}_${playerId}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(videoFile.content);

        const response = await drive.files.create({
            requestBody: {
                name: newFileName,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], // This is your original "My Drive" folder ID
            },
            media: {
                mimeType: videoFile.contentType,
                body: bufferStream,
            },
            fields: 'id, webViewLink',
        });

        const fileId = response.data.id;
        const fileLink = response.data.webViewLink;

        // --- Update Google Sheets ---
        await appendSheetData(auth, 'Actions_Mafia!A:D', [
            timestamp,
            playerId,
            'Video Kill Upload',
            `FileID: ${fileId}`
        ]);

        await updateSheetData(auth, `Players!D${playerRowIndex}`, ['TRUE']);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Video uploaded and action logged successfully!',
                fileId: fileId,
                fileLink: fileLink
            }),
        };

    } catch (error) {
        console.error('Upload Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred during upload.', details: error.message }),
        };
    }
};
