// netlify/functions/submit-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const Busboy = require('busboy'); // For parsing multipart/form-data
const { Readable } = require('stream'); // Import Readable from Node.js stream module

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;
const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID; // New env variable

// Extend scopes for Google Drive access
const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets', // Full sheets access for writing
        'https://www.googleapis.com/auth/drive.file', // Allows app to manage files it creates or opens
        'https://www.googleapis.com/auth/drive' // Broader access, good for troubleshooting
    ]
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!sheetId || !driveFolderId) {
        console.error('Configuration Error: Google Sheet ID or Drive Folder ID is not configured.');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error: Sheet or Drive ID missing.' }),
        };
    }

    return new Promise((resolve) => {
        // Ensure event.body exists and is a string for Busboy to parse
        if (!event.body) {
            console.error('Busboy Error: Event body is empty.');
            resolve({ statusCode: 400, body: JSON.stringify({ error: 'Request body is empty.' }) });
            return;
        }

        const busboy = Busboy({ headers: event.headers });
        let fileBuffer = null;
        let originalFileName = '';
        let fileMimeType = '';
        let fields = {};

        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            console.log(`Busboy: File [${fieldname}]: filename=${filename.filename}, encoding=${encoding}, mimetype=${mimetype}`);
            // Only process the first file, expecting audio
            originalFileName = filename.filename;
            fileMimeType = mimetype;
            const chunks = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
                console.log(`Busboy: File received. Buffer size: ${fileBuffer.length} bytes.`);
            });
            file.on('error', (err) => {
                console.error('Busboy: File stream error:', err);
            });
        });

        busboy.on('field', (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) => {
            console.log(`Busboy: Field [${fieldname}]: value=${val}`);
            fields[fieldname] = val;
        });

        busboy.on('finish', async () => {
            try {
                const { accuserPlayerId, accusedPlayerId } = fields;

                if (!fileBuffer || !accuserPlayerId || !accusedPlayerId) {
                    console.error('Validation Error: Missing file or required form fields.', { fileBuffer: !!fileBuffer, accuserPlayerId, accusedPlayerId });
                    resolve({
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Missing audio file or player information. Please ensure all fields are selected and audio is recorded/selected.' }),
                    });
                    return;
                }

                if (fileBuffer.length === 0) {
                    console.error('Validation Error: Uploaded audio file is empty.');
                    resolve({
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Uploaded audio file is empty. Please record again or select a valid file.' }),
                    });
                    return;
                }

                // Determine file extension from MIME type if not provided by originalFileName
                let fileExtension = 'webm'; // Default for MediaRecorder output
                if (fileMimeType.includes('mp4')) {
                    fileExtension = 'mp4';
                } else if (fileMimeType.includes('ogg')) {
                    fileExtension = 'ogg';
                } else if (fileMimeType.includes('wav')) {
                    fileExtension = 'wav';
                } else if (fileMimeType.includes('mpeg')) { // for mp3
                    fileExtension = 'mp3';
                }

                // Ensure fileMimeType is simplified for Google Drive if it contains codecs
                const uploadMimeType = fileMimeType.split(';')[0]; // Take only the base MIME type

                // Construct a robust filename for Google Drive
                const driveFileName = `accusation_${accuserPlayerId}_${Date.now()}.${fileExtension}`;
                console.log(`Google Drive: Attempting to upload file: ${driveFileName} with simplified MIME type: ${uploadMimeType}`);

                // Convert Buffer to a Readable stream for Google Drive API
                const readableStream = new Readable();
                readableStream.push(fileBuffer);
                readableStream.push(null); // Indicate end of stream

                // 1. Upload audio to Google Drive
                const driveResponse = await drive.files.create({
                    requestBody: {
                        name: driveFileName,
                        parents: [driveFolderId],
                        mimeType: uploadMimeType, // Use the simplified MIME type
                    },
                    media: {
                        mimeType: uploadMimeType, // Use the simplified MIME type
                        body: readableStream, // Pass the Readable stream here
                    },
                    fields: 'id, webViewLink, webContentLink', // Request specific fields for links
                });

                const fileId = driveResponse.data.id;
                // Prefer webViewLink for direct browser playback, fallback to webContentLink
                const driveLink = driveResponse.data.webViewLink || driveResponse.data.webContentLink || `https://drive.google.com/uc?id=${fileId}&export=download`;
                console.log(`Google Drive: File uploaded. ID: ${fileId}, Link: ${driveLink}`);

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
                console.log('Google Sheets: Appending new accusation:', values);

                await sheets.spreadsheets.values.append({
                    spreadsheetId: sheetId,
                    range: 'Accusations!A:H', // Adjust range if your sheet columns change
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [values],
                    },
                });
                console.log('Google Sheets: Accusation appended successfully.');

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
                console.error('Server Error: Failed to submit accusation:', error);
                // Provide more specific error details if available
                let errorMessage = 'Failed to submit accusation.';
                if (error.response && error.response.data && error.response.data.error) {
                    errorMessage = `Google API Error: ${error.response.data.error.message || error.message}`;
                    console.error('Google API Error Details:', error.response.data.error);
                } else if (error.message) {
                    errorMessage = `Internal Server Error: ${error.message}`;
                }
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ error: errorMessage }),
                });
            }
        });

        busboy.on('error', (err) => {
            console.error('Busboy: Global parsing error:', err);
            resolve({ statusCode: 500, body: JSON.stringify({ error: 'Failed to parse form data.' }) });
        });

        // Pipe the event body to busboy
        try {
            busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        } catch (parseError) {
            console.error('Error ending busboy stream:', parseError);
            resolve({ statusCode: 500, body: JSON.stringify({ error: 'Failed to process request body.' }) });
        }
    });
};
