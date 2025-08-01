// netlify/functions/transcode-audio.js

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const { Storage } = require('@google-cloud/storage');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

// Initialize GCS Storage
let storage;
try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    storage = new Storage({
        projectId: credentials.project_id,
        credentials,
    });
} catch (e) {
    console.error("transcode-audio: CRITICAL: Failed to parse GCS credentials:", e.message);
    storage = null;
}

exports.handler = async (event, context) => {
    console.log("--- TRANSCODE-AUDIO (STABLE) INITIATED ---");

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!storage) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS not initialized.' }) };
    }

    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS bucket name missing.' }) };
    }

    let originalGcsUrl;
    try {
        const body = JSON.parse(event.body);
        originalGcsUrl = body.originalGcsUrl;
        if (!originalGcsUrl) throw new Error("Missing originalGcsUrl in request body.");
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }
    
    const urlParts = originalGcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)/);
    if (!urlParts || urlParts.length < 3) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid GCS URL provided.' }) };
    }

    const originalGcsPath = urlParts[2];
    const originalFileName = path.basename(originalGcsPath);
    const tempDir = os.tmpdir();
    
    const downloadedInputPath = path.join(tempDir, `original_${originalFileName}`);
    const finalMp4Path = path.join(tempDir, `${path.parse(originalFileName).name}_transcoded.mp4`);
    const finalGcsPath = `accusations/${path.basename(finalMp4Path)}`;

    const filesToCleanup = [downloadedInputPath, finalMp4Path];

    try {
        await storage.bucket(bucketName).file(originalGcsPath).download({ destination: downloadedInputPath });
        
        // --- STABLE TRANSCODING ONLY ---
        await new Promise((resolve, reject) => {
            ffmpeg(downloadedInputPath)
                .noVideo() // Keep this for stability with MP4 files
                .audioCodec('aac')
                .audioBitrate(128)
                .output(finalMp4Path)
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg transcoding failed: ${err.message}`)))
                .run();
        });

        // --- Upload Final File ---
        const [uploadedFile] = await storage.bucket(bucketName).upload(finalMp4Path, {
            destination: finalGcsPath,
            metadata: { contentType: 'audio/mp4' },
            public: true,
        });
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Audio transcoded successfully!',
                transcodedGcsUrl: uploadedFile.publicUrl(),
            }),
        };

    } catch (error) {
        console.error("[FATAL ERROR] An error occurred in the main try/catch block.", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process audio.', details: error.message }),
        };
    } finally {
        // --- Cleanup ---
        for (const filePath of filesToCleanup) {
            try { await fs.unlink(filePath); } catch (e) {
                if (e.code !== 'ENOENT') console.warn(`[WARN] Failed to clean up temp file ${filePath}: ${e.message}`);
            }
        }
    }
};