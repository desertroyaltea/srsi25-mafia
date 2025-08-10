// File: netlify/functions/upload-kill-video.js

const { google } = require('googleapis');
const busboy = require('busboy');
const stream = require('stream');

// --- Google Sheets API Helper (You should move this to a shared file later) ---
async function getGoogleSheetsClient() {
    // FIX: Use the correct environment variable name
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return await auth.getClient();
}

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
        const { playerId, sessionId } = fields; // sessionId is no longer used for validation but kept for potential future use
        const videoFile = files.videoFile;

        if (!playerId || !videoFile) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: playerId or videoFile.' }) };
        }

        // --- Get Player Info (Session check removed as requested) ---
        const auth = await getGoogleSheetsClient();
        const playersData = await getSheetData(auth, 'Players!A:F'); // Assuming SessionID is in F
        const playerRow = playersData.find(row => row[0] === playerId);

        if (!playerRow) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        }
        
        const playerName = playerRow[1]; // Assuming Name is in column B
        const playerRowIndex = playersData.findIndex(row => row[0] === playerId) + 1;

        // --- Upload to Google Drive ---
        const driveAuth = new google.auth.GoogleAuth({
            // FIX: Use the correct environment variable name
            credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS),
            scopes: ['https://www.googleapis.com/auth/drive'],
        });
        const drive = google.drive({ version: 'v3', auth: driveAuth });

        const timestamp = new Date().toISOString();
        const newFileName = `${timestamp}_${playerName}_${playerId}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(videoFile.content);

        const response = await drive.files.create({
            requestBody: {
                name: newFileName,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], // The ID of the folder to upload into
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
        // 1. Log the action
        await appendSheetData(auth, 'Actions_Mafia!A:D', [
            timestamp,
            playerId,
            'Video Kill Upload',
            `FileID: ${fileId}`
        ]);

        // 2. Mark MainUsed as TRUE for the player
        await updateSheetData(auth, `Players!D${playerRowIndex}`, ['TRUE']); // Assuming MainUsed is in column D

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
