// netlify/functions/submit-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const Busboy = require('busboy');
const { Storage } = require('@google-cloud/storage');
const { Readable } = require('stream');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;
const bucketName = process.env.GCS_BUCKET_NAME;

const storage = new Storage({
    projectId: credentials.project_id,
    credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
    },
});

const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!sheetId || !bucketName) {
        console.error('Configuration Error: Google Sheet ID or GCS Bucket Name is not configured.');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    return new Promise((resolve) => {
        if (!event.body) {
            return resolve({ statusCode: 400, body: JSON.stringify({ error: 'Request body is empty.' }) });
        }

        const busboy = Busboy({ headers: event.headers });
        let fileBuffer = null;
        let originalFileName = '';
        let fileMimeType = '';
        let fields = {};

        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            originalFileName = filename.filename;
            fileMimeType = mimetype || 'application/octet-stream';
            const chunks = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('finish', async () => {
            try {
                const { accuserPlayerId, accusedPlayerId } = fields;

                if (!fileBuffer || !accuserPlayerId || !accusedPlayerId) {
                    return resolve({
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Missing audio file or player information.' }),
                    });
                }

                // --- Determine file extension and MIME type for GCS upload ---
                let determinedMimeType = fileMimeType.split(';')[0]; // Clean up MIME type (e.g., audio/webm)
                let fileExtension = 'bin'; // Default fallback

                // Extract extension from originalFileName if present
                const extensionMatch = originalFileName.match(/\.([0-9a-z]+)$/i);
                if (extensionMatch) {
                    fileExtension = extensionMatch[1].toLowerCase();
                } else {
                    // Fallback to determine extension from MIME type if not in filename
                    if (determinedMimeType.includes('mp4')) fileExtension = 'mp4';
                    else if (determinedMimeType.includes('wav')) fileExtension = 'wav';
                    else if (determinedMimeType.includes('webm')) fileExtension = 'webm';
                    else if (determinedMimeType.includes('mpeg')) fileExtension = 'mp3';
                }

                const gcsFileName = `accusation_${accuserPlayerId}_${Date.now()}.${fileExtension}`;
                const gcsFilePath = `accusations/${gcsFileName}`;
                
                console.log(`submit-accusation: GCS Upload: Filename=${gcsFileName}, MIMEType=${determinedMimeType}`);

                const gcsFile = storage.bucket(bucketName).file(gcsFilePath);
                const writeStream = gcsFile.createWriteStream({
                    metadata: { contentType: determinedMimeType },
                });

                await new Promise((streamResolve, streamReject) => {
                    const bufferStream = new Readable();
                    bufferStream.push(fileBuffer);
                    bufferStream.push(null);
                    bufferStream.pipe(writeStream)
                        .on('error', (err) => streamReject(err))
                        .on('finish', () => streamResolve());
                });

                await gcsFile.makePublic();
                const originalGcsUrl = `https://storage.googleapis.com/${bucketName}/${gcsFilePath}`;
                console.log(`submit-accusation: Original file uploaded. Public URL: ${originalGcsUrl}`);

                // --- Trigger Transcoding Function ---
                let finalAudioUrl = originalGcsUrl; // Default to original if transcoding fails or isn't needed
                try {
                    console.log("submit-accusation: Triggering audio transcoding...");
                    const transcodeResponse = await fetch('https://' + event.headers.host + '/.netlify/functions/transcode-audio', { // Use full URL for internal function call
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            originalGcsUrl: originalGcsUrl,
                            targetFormat: 'mp4' // Request MP4 for broad compatibility
                        }),
                    });

                    const transcodeResult = await transcodeResponse.json();

                    if (transcodeResponse.ok && transcodeResult.transcodedGcsUrl) {
                        finalAudioUrl = transcodeResult.transcodedGcsUrl;
                        console.log(`submit-accusation: Audio transcoded successfully. Final URL: ${finalAudioUrl}`);
                    } else {
                        console.error(`submit-accusation: Transcoding failed or returned no URL: ${transcodeResult.message || JSON.stringify(transcodeResult)}`);
                        console.warn("submit-accusation: Falling back to original audio URL due to transcoding failure.");
                    }
                } catch (transcodeError) {
                    console.error("submit-accusation: Error calling transcode-audio function:", transcodeError);
                    console.warn("submit-accusation: Falling back to original audio URL due to transcoding function call error.");
                }
                // --- END Trigger Transcoding Function ---

                // Add entry to Accusations sheet with the FINAL audio URL
                const accusationId = `ACC_${Date.now()}`; // Declare here, use below
                const submissionTime = new Date().toISOString(); // Declare here, use below
                const values = [ // Declare here, use below
                    accusationId,
                    accuserPlayerId,
                    accusedPlayerId,
                    finalAudioUrl, // Use the transcoded URL here
                    submissionTime,
                    'Pending',
                    '',
                    'FALSE'
                ];

                await sheets.spreadsheets.values.append({
                    spreadsheetId: sheetId,
                    range: 'Accusations!A:H',
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [values] },
                });

                resolve({
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: 'Accusation submitted successfully!',
                        accusationId: accusationId,
                    }),
                });

            } catch (error) {
                console.error('submit-accusation: Server Error:', error);
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to submit accusation.', details: error.message }),
                });
            }
        });

        // This part handles streaming the event body to busboy
        // Netlify functions provide event.body as a string, potentially base64 encoded
        // busboy needs a stream or buffer.
        // We'll create a readable stream from the event body.
        const bodyStream = new Readable();
        bodyStream.push(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        bodyStream.push(null); // No more data

        bodyStream.pipe(busboy); // Pipe the stream to busboy
    });
};