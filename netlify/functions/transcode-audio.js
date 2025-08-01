// netlify/functions/transcode-audio.js

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const { Storage } = require('@google-cloud/storage');
const { Readable } = require('stream');
const os = require('os'); // Node.js built-in module for OS-specific temp directory
const path = require('path'); // Node.js built-in module for path manipulation
const fs = require('fs/promises'); // Node.js built-in module for file system operations (promises-based)

// Initialize GCS Storage outside the handler for better performance
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
    storage = null; // Ensure storage is null if credentials fail
}

exports.handler = async (event, context) => {
    console.log("transcode-audio: Function started.");

    if (event.httpMethod !== 'POST') {
        console.log("transcode-audio: Method Not Allowed.");
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!storage) {
        console.error("transcode-audio: Google Cloud Storage not initialized. Check GOOGLE_SERVICE_ACCOUNT_CREDENTIALS.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS not initialized.' }) };
    }

    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
        console.error("transcode-audio: GCS_BUCKET_NAME is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS bucket name missing.' }) };
    }

    let originalGcsUrl, targetFormat = 'mp4'; // Default target format
    try {
        const body = JSON.parse(event.body);
        originalGcsUrl = body.originalGcsUrl;
        if (body.targetFormat) {
            targetFormat = body.targetFormat; // Allow specifying 'wav' or 'mp4'
        }
    } catch (e) {
        console.error("transcode-audio: Invalid JSON body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    if (!originalGcsUrl) {
        console.error("transcode-audio: Missing originalGcsUrl in request body.");
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing originalGcsUrl.' }) };
    }

    // Extract bucket and file path from the GCS URL
    const urlParts = originalGcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)/);
    if (!urlParts || urlParts.length < 3 || urlParts[1] !== bucketName) {
        console.error(`transcode-audio: Invalid GCS URL or bucket mismatch: ${originalGcsUrl}`);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid GCS URL provided.' }) };
    }
    const originalFilePath = urlParts[2];
    const originalFileName = path.basename(originalFilePath);
    const originalFileDir = path.dirname(originalFilePath);

    const tempDir = os.tmpdir();
    const inputFilePath = path.join(tempDir, originalFileName);
    const outputFileName = `${path.parse(originalFileName).name}_converted.${targetFormat}`;
    const outputFilePath = path.join(tempDir, outputFileName);
    const outputGcsPath = `${originalFileDir}/${outputFileName}`; // Keep in same GCS folder

    console.log(`transcode-audio: Original GCS Path: ${originalFilePath}`);
    console.log(`transcode-audio: Input Temp Path: ${inputFilePath}`);
    console.log(`transcode-audio: Output Temp Path: ${outputFilePath}`);
    console.log(`transcode-audio: Output GCS Path: ${outputGcsPath}`);

    let cleanupFiles = []; // To track files to delete

    try {
        // 1. Download the original file from GCS to a temporary location
        console.log(`transcode-audio: Downloading ${originalFilePath} from GCS.`);
        await storage.bucket(bucketName).file(originalFilePath).download({ destination: inputFilePath });
        cleanupFiles.push(inputFilePath);
        console.log("transcode-audio: Download complete.");

        // 2. Transcode the audio using ffmpeg
        console.log(`transcode-audio: Starting transcoding to ${targetFormat}.`);
        await new Promise((resolve, reject) => {
            ffmpeg(inputFilePath)
                .output(outputFilePath)
                .audioCodec(targetFormat === 'mp4' ? 'aac' : 'pcm_s16le') // Use AAC for MP4, PCM for WAV
                .audioBitrate(targetFormat === 'mp4' ? 128 : undefined) // Optional: bitrate for MP4
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
        console.log("transcode-audio: Transcoding complete.");

        // 3. Upload the transcoded file back to GCS
        console.log(`transcode-audio: Uploading ${outputFileName} to GCS.`);
        const [uploadedFile] = await storage.bucket(bucketName).upload(outputFilePath, {
            destination: outputGcsPath,
            metadata: {
                contentType: targetFormat === 'mp4' ? 'audio/mp4' : 'audio/wav',
            },
            public: true, // Make the new file public
        });
        console.log("transcode-audio: Upload complete.");

        const transcodedGcsUrl = uploadedFile.publicUrl();
        console.log(`transcode-audio: Transcoded file public URL: ${transcodedGcsUrl}`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Audio transcoded and uploaded successfully!',
                transcodedGcsUrl: transcodedGcsUrl,
                originalGcsUrl: originalGcsUrl // Optionally return original too
            }),
        };

    } catch (error) {
        console.error('transcode-audio: Error in handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to transcode audio.', details: error.message }),
        };
    } finally {
        // Clean up temporary files
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