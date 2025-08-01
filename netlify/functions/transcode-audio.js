// netlify/functions/transcode-audio.js

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const { Storage } = require('@google-cloud/storage');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

let storage;
try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    storage = new Storage({
        projectId: credentials.project_id,
        credentials: {
            client_email: credentials.client_email,
            private_key: credentials.private_key,
        },
    });
} catch (e) {
    console.error("transcode-audio: Failed to parse GCS credentials:", e.message);
    storage = null;
}

exports.handler = async (event, context) => {
    console.log("transcode-audio: Function started.");

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!storage) {
        console.error("transcode-audio: Google Cloud Storage not initialized.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS not initialized.' }) };
    }

    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
        console.error("transcode-audio: GCS_BUCKET_NAME is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS bucket name missing.' }) };
    }

    let originalGcsUrl, targetFormat = 'mp4';
    try {
        const body = JSON.parse(event.body);
        originalGcsUrl = body.originalGcsUrl;
        if (body.targetFormat) {
            targetFormat = body.targetFormat;
        }
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    if (!originalGcsUrl) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing originalGcsUrl.' }) };
    }

    const urlParts = originalGcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)/);
    if (!urlParts || urlParts.length < 3 || urlParts[1] !== bucketName) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid GCS URL provided.' }) };
    }
    const originalFilePath = urlParts[2];
    const originalFileName = path.basename(originalFilePath);
    const originalFileDir = path.dirname(originalFilePath);

    const tempDir = os.tmpdir();
    const inputFilePath = path.join(tempDir, originalFileName);
    const outputFileName = `${path.parse(originalFileName).name}_masked.${targetFormat}`; // Changed name for clarity
    const outputFilePath = path.join(tempDir, outputFileName);
    const outputGcsPath = `${originalFileDir}/${outputFileName}`;

    let cleanupFiles = [];

    try {
        console.log(`transcode-audio: Downloading ${originalFilePath} from GCS.`);
        await storage.bucket(bucketName).file(originalFilePath).download({ destination: inputFilePath });
        cleanupFiles.push(inputFilePath);

        console.log(`transcode-audio: Starting transcoding with voice mask to ${targetFormat}.`);
        await new Promise((resolve, reject) => {
            ffmpeg(inputFilePath)
                // === 🎙️ VOICE EFFECT ADDED HERE ===
            // Standardize the audio sample rate to fix mobile compatibility
            .audioFrequency(44100)
                // This lowers the pitch without changing the audio's speed.
                .audioFilter('asetrate=44100*0.8,atempo=1.25')
                // ==================================
                .audioCodec(targetFormat === 'mp4' ? 'aac' : 'pcm_s16le')
                .audioBitrate(targetFormat === 'mp4' ? 128 : undefined)
                .output(outputFilePath)
                .on('end', () => {
                    console.log("transcode-audio: Transcoding finished.");
                    resolve();
                })
                .on('error', (err) => {
                    console.error("transcode-audio: FFmpeg error:", err.message);
                    reject(new Error(`FFmpeg transcoding failed: ${err.message}`));
                })
                .run();
        });
        cleanupFiles.push(outputFilePath);

        console.log(`transcode-audio: Uploading ${outputFileName} to GCS.`);
        const [uploadedFile] = await storage.bucket(bucketName).upload(outputFilePath, {
            destination: outputGcsPath,
            metadata: {
                contentType: targetFormat === 'mp4' ? 'audio/mp4' : 'audio/wav',
            },
            public: true,
        });
        
        const transcodedGcsUrl = uploadedFile.publicUrl();
        console.log(`transcode-audio: Transcoded file public URL: ${transcodedGcsUrl}`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Audio processed with voice mask and uploaded successfully!',
                transcodedGcsUrl: transcodedGcsUrl,
            }),
        };

    } catch (error) {
        console.error('transcode-audio: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process audio.', details: error.message }),
        };
    } finally {
        for (const filePath of cleanupFiles) {
            try {
                await fs.unlink(filePath);
                console.log(`transcode-audio: Cleaned up temp file: ${filePath}`);
            } catch (e) {
                console.warn(`transcode-audio: Failed to clean up temp file ${filePath}: ${e.message}`);
            }
        }
        console.log("transcode-audio: Function finished.");
    }
};