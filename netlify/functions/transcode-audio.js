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

// --- Main Handler ---
exports.handler = async (event, context) => {
    console.log("--- TRANSCODE-AUDIO V4 (NEW FILTER) INITIATED ---");

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
    const sanitizedWavPath = path.join(tempDir, `${path.parse(originalFileName).name}.wav`);
    const finalMp4Path = path.join(tempDir, `${path.parse(originalFileName).name}_masked.mp4`);
    const finalGcsPath = `accusations/${path.basename(finalMp4Path)}`;

    const filesToCleanup = [downloadedInputPath, sanitizedWavPath, finalMp4Path];

    try {
        // --- PASS 1: Sanitize to WAV ---
        await storage.bucket(bucketName).file(originalGcsPath).download({ destination: downloadedInputPath });
        
        await new Promise((resolve, reject) => {
            ffmpeg(downloadedInputPath)
                .noVideo()
                .outputOptions('-acodec pcm_s16le')
                .toFormat('wav')
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg sanitization failed: ${err.message}`)))
                .save(sanitizedWavPath);
        });

        // --- PASS 2: Apply NEW Effect and Encode to MP4 ---
        await new Promise((resolve, reject) => {
            ffmpeg(sanitizedWavPath)
                .audioCodec('aac')
                .audioFrequency(44100)
                // === ❗️ FINAL ATTEMPT WITH NEW FILTER ===
                // This uses a different, more stable method to lower the pitch.
                // (35280 is 44100 * 0.8)
                .audioFilter('aresample=35280,atempo=0.8')
                // =========================================
                .audioBitrate(128)
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg effect/encoding failed: ${err.message}`)))
                .save(finalMp4Path);
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
                message: 'Audio processed successfully!',
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