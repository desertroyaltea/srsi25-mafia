// netlify/functions/submit-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const Busboy = require('busboy'); // For parsing multipart/form-data

// Make sure to npm install busboy in your netlify/functions directory or project root
// npm install busboy

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;
const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID; // New env variable

// Extend scopes for Google Drive access
const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets', // Full sheets access for writing
        'https://www.googleapis.com/auth/drive.file' // Allows app to manage files it creates or opens
    ]
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!sheetId || !driveFolderId) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Google Sheet ID or Drive Folder ID is not configured.' }),
        };
    }

    return new Promise((resolve) => {
        const busboy = Busboy({ headers: event.headers });
        let fileBuffer = null;
        let fileName = '';
        let mimeType = '';
        let fields = {};

        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            // Only process the first file, expecting audio
            fileName = filename.filename;
            mimeType = mimetype;
            const chunks = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        busboy.on('field', (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) => {
            fields[fieldname] = val;
        });

        busboy.on('finish', async () => {
            try {
                const { accuserPlayerId, accusedPlayerId } = fields;

                if (!fileBuffer || !accuserPlayerId || !accusedPlayerId) {
                    resolve({
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Missing file or required form fields (accuserPlayerId, accusedPlayerId).' }),
                    });
                    return;
                }

                // 1. Upload audio to Google Drive
                const driveResponse = await drive.files.create({
                    requestBody: {
                        name: `accusation_${accuserPlayerId}_${Date.now()}.mp3`, // Or whatever file extension
                        parents: [driveFolderId], // The specific folder ID
                        mimeType: mimeType,
                    },
                    media: {
                        mimeType: mimeType,
                        body: fileBuffer,
                    },
                });

                const fileId = driveResponse.data.id;
                // Generate a web-viewable link for the file
                const driveLink = `https://drive.google.com/uc?id=${fileId}&export=download`; // Direct download link

                // 2. Add entry to Accusations sheet
                // AccusationID,AccuserPlayerID,AccusedPlayerID,AudioDriveLink,SubmissionTime,AdminApprovalStatus,AdminApprovalTime,TrialStarted
                const accusationId = `ACC_${Date.now()}`; // Simple unique ID
                const submissionTime = new Date().toISOString();
                const values = [
                    accusationId,
                    accuserPlayerId,
                    accusedPlayerId,
                    driveLink,
                    submissionTime,
                    'Pending', // Initial status
                    '',        // AdminApprovalTime
                    'FALSE'    // TrialStarted
                ];

                await sheets.spreadsheets.values.append({
                    spreadsheetId: sheetId,
                    range: 'Accusations!A:H', // Adjust range if your sheet columns change
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [values],
                    },
                });

                resolve({
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: 'Accusation submitted successfully!',
                        accusationId: accusationId,
                        driveLink: driveLink
                    }),
                });

            } catch (error) {
                console.error('Error submitting accusation:', error);
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to submit accusation', details: error.message }),
                });
            }
        });

        // Pipe the event body to busboy
        busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    });
};
