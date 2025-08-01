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
        console.error('submit-accusation: Configuration Error: Google Sheet ID or GCS Bucket Name is not configured.');
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
            let accuserPlayerId, accusedPlayerId;
            try {
                accuserPlayerId = fields.accuserPlayerId;
                accusedPlayerId = fields.accusedPlayerId;
            } catch (e) {
                console.error("submit-accusation: Error parsing form fields:", e.message);
                return resolve({ statusCode: 400, body: JSON.stringify({ error: 'Invalid form data.' }) });
            }

            if (!fileBuffer || !accuserPlayerId || !accusedPlayerId) {
                return resolve({
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Missing audio file or player information.' }),
                });
            }

            try {
                // Fetch all player data to validate
                const playersResponse = await sheets.spreadsheets.values.get({
                    spreadsheetId: sheetId,
                    range: 'Players!A:S', // Fetch up to IsAdmin column (S) for validation
                });
                const playersData = playersResponse.data.values || [];
                if (playersData.length < 1) {
                    console.error("submit-accusation: Players sheet is empty for validation.");
                    return resolve({ statusCode: 500, body: JSON.stringify({ error: 'Players sheet is empty.' }) });
                }
                const playerHeaders = playersData[0];
                const playerRows = playersData.slice(1);

                const idCol = playerHeaders.indexOf('PlayerID');
                const nameCol = playerHeaders.indexOf('Name');
                const statusCol = playerHeaders.indexOf('Status');
                const isAdminCol = playerHeaders.indexOf('IsAdmin');

                if ([idCol, nameCol, statusCol, isAdminCol].includes(-1)) {
                    console.error("submit-accusation: Required columns not found in Players sheet.");
                    throw new Error("Required columns (PlayerID, Name, Status, IsAdmin) not found in Players sheet.");
                }

                // Helper to get player info by ID
                const getPlayerInfoById = (id) => {
                    for (let i = 0; i < playerRows.length; i++) {
                        if (String(playerRows[i][idCol]).trim() === id) {
                            return {
                                playerID: String(playerRows[i][idCol]).trim(),
                                playerName: String(playerRows[i][nameCol]).trim(),
                                playerStatus: String(playerRows[i][statusCol]).trim(),
                                playerIsAdmin: String(playerRows[i][isAdminCol]).trim(),
                                rowIndex: i + 2
                            };
                        }
                    }
                    return null;
                };

                // Validate Accuser player (by ID)
                const accuserInfo = getPlayerInfoById(accuserPlayerId);
                if (!accuserInfo) {
                    return resolve({ statusCode: 404, body: JSON.stringify({ error: 'Accuser player not found.' }) });
                }
                if (accuserInfo.playerStatus.toLowerCase() !== 'alive') {
                    return resolve({ statusCode: 403, body: JSON.stringify({ error: 'Only alive players can accuse.' }) });
                }
                if (accuserInfo.playerIsAdmin === 'TRUE') {
                    return resolve({ statusCode: 403, body: JSON.stringify({ error: 'Admin players cannot accuse.' }) });
                }

                // Validate Accused player (by ID)
                const accusedInfo = getPlayerInfoById(accusedPlayerId);
                if (!accusedInfo) {
                    return resolve({ statusCode: 404, body: JSON.stringify({ error: `Accused player (${accusedPlayerId}) not found.` }) });
                }
                if (accusedInfo.playerStatus.toLowerCase() !== 'alive') {
                    return resolve({ statusCode: 400, body: JSON.stringify({ error: `Accused player (${accusedPlayerId}) is not alive.` }) });
                }
                if (accusedInfo.playerIsAdmin === 'TRUE') {
                    return resolve({ statusCode: 403, body: JSON.stringify({ error: `Accused player (${accusedPlayerId}) is an Admin and cannot be accused.` }) });
                }

                // Determine file extension based on the actual recorded MIME type
                let fileExtension = 'bin';
                if (fileMimeType.includes('mp4')) {
                    fileExtension = 'mp4';
                } else if (fileMimeType.includes('wav')) {
                    fileExtension = 'wav';
                } else if (fileMimeType.includes('webm')) {
                    fileExtension = 'webm';
                }

                const gcsFileName = `accusation_${accuserPlayerId}_${Date.now()}.${fileExtension}`;
                const gcsFilePath = `accusations/${gcsFileName}`;
                
                const gcsFile = storage.bucket(bucketName).file(gcsFilePath);
                const writeStream = gcsFile.createWriteStream({
                    metadata: { contentType: fileMimeType },
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

                let finalAudioUrl = originalGcsUrl;
                try {
                    const transcodeResponse = await fetch('https://' + event.headers.host + '/.netlify/functions/transcode-audio', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            originalGcsUrl: originalGcsUrl,
                            targetFormat: 'mp4'
                        }),
                    });

                    const transcodeResult = await transcodeResponse.json();

                    if (transcodeResponse.ok && transcodeResult.transcodedGcsUrl) {
                        finalAudioUrl = transcodeResult.transcodedGcsUrl;
                    } else {
                        console.error(`submit-accusation: Transcoding failed or returned no URL: ${transcodeResult.message || JSON.stringify(transcodeResult)}`);
                    }
                } catch (transcodeError) {
                    console.error("submit-accusation: Error calling transcode-audio function:", transcodeError);
                }

                const accusationId = `ACC_${Date.now()}`;
                const submissionTime = new Date().toISOString();
                const values = [
                    accusationId,
                    accuserPlayerId,
                    accusedPlayerId,
                    finalAudioUrl,
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
                console.error('submit-accusation: Error in try-catch block:', error);
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to submit accusation.', details: error.message }),
                });
            }
        });

        const bodyStream = new Readable();
        bodyStream.push(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        bodyStream.push(null);

        bodyStream.pipe(busboy);
    });
};