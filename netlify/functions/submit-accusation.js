// netlify/functions/submit-accusation.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const Busboy = require('busboy');
const { Storage } = require('@google-cloud/storage'); // Import Google Cloud Storage client
const { Readable } = require('stream');

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
const sheetId = process.env.GOOGLE_SHEET_ID;
// New environment variable for GCS bucket name
const bucketName = process.env.GCS_BUCKET_NAME;

// Initialize Google Cloud Storage client
const storage = new Storage({
    projectId: credentials.project_id,
    credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
    },
});

// Extend scopes for Google Sheets access
const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets' // Full sheets access for writing
    ]
});

const sheets = google.sheets({ version: 'v4', auth });

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!sheetId || !bucketName) {
        console.error('Configuration Error: Google Sheet ID or GCS Bucket Name is not configured.');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error: Sheet ID or GCS Bucket Name missing.' }),
        };
    }

    return new Promise((resolve) => {
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
            originalFileName = filename.filename;
            fileMimeType = mimetype || 'application/octet-stream'; // Fallback to a generic binary type if mimetype is undefined
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

                // --- Improved MIME type and Extension determination ---
                let determinedMimeType = fileMimeType;
                let fileExtension = 'bin'; // Default to .bin if no specific audio type is found

                if (fileMimeType.includes('webm')) {
                    fileExtension = 'webm';
                    determinedMimeType = 'audio/webm';
                } else if (fileMimeType.includes('mp4')) {
                    fileExtension = 'mp4';
                    determinedMimeType = 'audio/mp4';
                } else if (fileMimeType.includes('ogg')) {
                    fileExtension = 'ogg';
                    determinedMimeType = 'audio/ogg';
                } else if (fileMimeType.includes('wav')) {
                    fileExtension = 'wav';
                    determinedMimeType = 'audio/wav';
                } else if (fileMimeType.includes('mpeg')) { // for mp3
                    fileExtension = 'mp3';
                    determinedMimeType = 'audio/mpeg';
                } else {
                    // Fallback for unknown or generic mimetypes. Try to guess from originalFileName if available
                    const originalExtMatch = originalFileName.match(/\.([0-9a-z]+)(?:[\?#]|$)/i);
                    if (originalExtMatch) {
                        const ext = originalExtMatch[1].toLowerCase();
                        if (ext === 'mp3') { fileExtension = 'mp3'; determinedMimeType = 'audio/mpeg'; }
                        else if (ext === 'wav') { fileExtension = 'wav'; determinedMimeType = 'audio/wav'; }
                        else if (ext === 'ogg') { fileExtension = 'ogg'; determinedMimeType = 'audio/ogg'; }
                        else if (ext === 'mp4') { fileExtension = 'mp4'; determinedMimeType = 'audio/mp4'; }
                        else if (ext === 'webm') { fileExtension = 'webm'; determinedMimeType = 'audio/webm'; }
                    }
                    console.warn(`MIME type '${fileMimeType}' is not a common audio type. Falling back to guessed extension '${fileExtension}' and MIME '${determinedMimeType}'.`);
                }
                // Ensure determinedMimeType is always a base type without codecs
                determinedMimeType = determinedMimeType.split(';')[0];


                const gcsFileName = `accusation_${accuserPlayerId}_${Date.now()}.${fileExtension}`;
                const gcsFilePath = `accusations/${gcsFileName}`; // Store in a subfolder within the bucket
                
                console.log(`GCS Upload Details: Filename=${gcsFileName}, Path=${gcsFilePath}, MIMEType=${determinedMimeType}, OriginalMIME=${fileMimeType}`);

                // Create a file object in the bucket
                const file = storage.bucket(bucketName).file(gcsFilePath);

                // Create a write stream to upload the buffer
                const writeStream = file.createWriteStream({
                    metadata: {
                        contentType: determinedMimeType, // Use the determined MIME type here
                    },
                    resumable: false, // For smaller files, resumable upload is not needed
                });

                // Pipe the file buffer to the write stream
                await new Promise((streamResolve, streamReject) => {
                    const bufferStream = new Readable();
                    bufferStream.push(fileBuffer);
                    bufferStream.push(null); // End the stream

                    bufferStream.pipe(writeStream)
                        .on('error', (err) => {
                            console.error('GCS Upload Stream Error:', err);
                            streamReject(err);
                        })
                        .on('finish', () => {
                            console.log('GCS Upload Stream Finished.');
                            streamResolve();
                        });
                });

                // Make the file publicly readable (optional, but needed for direct playback links)
                // WARNING: This makes the file accessible to anyone with the link.
                // For production, consider signed URLs or more controlled access.
                await file.makePublic(); 
                
                const gcsPublicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFilePath}`;
                console.log(`Google Cloud Storage: File uploaded. Public URL: ${gcsPublicUrl}`);

                // 2. Add entry to Accusations sheet
                const accusationId = `ACC_${Date.now()}`;
                const submissionTime = new Date().toISOString();
                const values = [
                    accusationId,
                    accuserPlayerId,
                    accusedPlayerId,
                    gcsPublicUrl, // Use the GCS public URL here
                    submissionTime,
                    'Pending',
                    '',
                    'FALSE'
                ];
                console.log('Google Sheets: Appending new accusation:', values);

                await sheets.spreadsheets.values.append({
                    spreadsheetId: sheetId,
                    range: 'Accusations!A:H',
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
                        driveLink: gcsPublicUrl // Return GCS URL
                    }),
                });

            } catch (error) {
                console.error('Server Error: Failed to submit accusation:', error);
                let errorMessage = 'Failed to submit accusation.';
                if (error.code) { // Google Cloud Storage errors often have a 'code'
                    errorMessage = `GCS Error (${error.code}): ${error.message}`;
                } else if (error.response && error.response.data && error.response.data.error) {
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

        try {
            busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        } catch (parseError) {
            console.error('Error ending busboy stream:', parseError);
            resolve({ statusCode: 500, body: JSON.stringify({ error: 'Failed to process request body.' }) });
        }
    });
};
