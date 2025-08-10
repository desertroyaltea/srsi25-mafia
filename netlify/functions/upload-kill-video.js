// File: netlify/functions/upload-kill-video.js
// REPLACES the previous version entirely.

const { google } = require('googleapis');
const busboy = require('busboy');
const stream = require('stream');
const { v4: uuidv4 } = require('uuid'); // Add UUID for unique ActionIDs

async function getAuthenticatedClient(scopes) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        throw new Error("Missing Google OAuth credentials.");
    }
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "https://developers.google.com/oauthplayground");
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    return oauth2Client;
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

function parseMultipartForm(event) {
    return new Promise((resolve) => {
        const fields = {};
        const files = {};
        const bb = busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] } });
        bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
            const buffer = [];
            file.on('data', (data) => buffer.push(data));
            file.on('end', () => {
                files[fieldname] = { content: Buffer.concat(buffer), filename: filename.filename, contentType: mimetype };
            });
        });
        bb.on('field', (fieldname, val) => { fields[fieldname] = val; });
        bb.on('close', () => { resolve({ fields, files }); });
        bb.end(Buffer.from(event.body, 'base64'));
    });
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const { fields, files } = await parseMultipartForm(event);
        const { playerId, targetPlayerId } = fields;
        const videoFile = files.videoFile;

        if (!playerId || !targetPlayerId || !videoFile) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
        }

        const auth = await getAuthenticatedClient(['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']);
        
        const [playersData, gameStateData] = await Promise.all([
            getSheetData(auth, 'Players!A:B'),
            getSheetData(auth, 'GameState!A:B')
        ]);

        const playerRow = playersData.find(row => row[0] === playerId);
        if (!playerRow) return { statusCode: 404, body: JSON.stringify({ error: 'Player not found.' }) };
        
        const playerName = playerRow[1];
        const playerRowIndex = playersData.findIndex(row => row[0] === playerId) + 1;
        const currentDay = gameStateData[0] ? gameStateData[0][1] : 'N/A'; // Assuming Day is in B1

        const drive = google.drive({ version: 'v3', auth });
        const timestamp = new Date().toISOString();
        const safePlayerName = playerName.replace(/[^a-zA-Z0-9]/g, '_');
        const newFileName = `${timestamp}_${safePlayerName}_KILLS_${targetPlayerId}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(videoFile.content);

        const response = await drive.files.create({
            requestBody: { name: newFileName, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: videoFile.contentType, body: bufferStream },
            fields: 'id',
        });

        const fileId = response.data.id;
        const actionId = uuidv4();

        // Log to the new Video_Kill sheet
        await appendSheetData(auth, 'Video_Kill!A:F', [
            actionId,
            currentDay,
            playerId,
            targetPlayerId,
            timestamp,
            'Pending' // Initial status
        ]);

        // Mark MainUsed as TRUE for the player
        await updateSheetData(auth, `Players!D${playerRowIndex}`, ['TRUE']);

        return { statusCode: 200, body: JSON.stringify({ message: 'Video uploaded for review!' }) };

    } catch (error) {
        console.error('Upload Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.', details: error.message }) };
    }
};
