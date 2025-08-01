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
    console.log("--- TRANSCODE-AUDIO V3 (TWO-PASS) INITIATED ---");

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!storage) {
        console.error("transcode-audio: FATAL: GCS not initialized.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS not initialized.' }) };
    }

    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
        console.error("transcode-audio: FATAL: GCS_BUCKET_NAME is not configured.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: GCS bucket name missing.' }) };
    }

    // --- 1. Parse Request ---
    let originalGcsUrl;
    try {
        const body = JSON.parse(event.body);
        originalGcsUrl = body.originalGcsUrl;
        if (!originalGcsUrl) throw new Error("Missing originalGcsUrl in request body.");
        console.log(`[LOG] 1. Request parsed. Original GCS URL: ${originalGcsUrl}`);
    } catch (e) {
        console.error("[ERROR] 1. Failed to parse request body:", e.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    // --- 2. Define File Paths ---
    const urlParts = originalGcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)/);
    if (!urlParts || urlParts.length < 3) {
        console.error(`[ERROR] 2. Invalid GCS URL format: ${originalGcsUrl}`);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid GCS URL provided.' }) };
    }

    const originalGcsPath = urlParts[2];
    const originalFileName = path.basename(originalGcsPath);
    const tempDir = os.tmpdir();
    
    // Define paths for all 3 files we'll use
    const downloadedInputPath = path.join(tempDir, `original_${originalFileName}`);
    const sanitizedWavPath = path.join(tempDir, `${path.parse(originalFileName).name}.wav`);
    const finalMp4Path = path.join(tempDir, `${path.parse(originalFileName).name}_masked.mp4`);
    
    const finalGcsPath = `accusations/${path.basename(finalMp4Path)}`;

    console.log(`[LOG] 2a. Download Path: ${downloadedInputPath}`);
    console.log(`[LOG] 2b. Sanitized WAV Path: ${sanitizedWavPath}`);
    console.log(`[LOG] 2c. Final MP4 Path: ${finalMp4Path}`);

    const filesToCleanup = [downloadedInputPath, sanitizedWavPath, finalMp4Path];

    try {
        // --- 3. Download Original File ---
        console.log(`[LOG] 3. Downloading gs://${bucketName}/${originalGcsPath} to temp location...`);
        await storage.bucket(bucketName).file(originalGcsPath).download({ destination: downloadedInputPath });
        console.log("[LOG] 3. Download successful.");

        // --- 4. PASS 1: Sanitize to WAV ---
        console.log("[LOG] 4. Starting PASS 1: Sanitizing to WAV format...");
        await new Promise((resolve, reject) => {
            ffmpeg(downloadedInputPath)
                .noVideo() // Ensure we only process audio
                .outputOptions('-acodec pcm_s16le') // Raw audio codec
                .toFormat('wav')
                .on('end', () => {
                    console.log("[LOG] 4. PASS 1: Sanitizing to WAV finished successfully.");
                    resolve();
                })
                .on('error', (err) => {
                    console.error("[ERROR] 4. PASS 1: FFmpeg error during sanitization.", err);
                    reject(new Error(`FFmpeg sanitization failed: ${err.message}`));
                })
                .save(sanitizedWavPath);
        });

        // --- 5. PASS 2: Apply Effect and Encode to MP4 ---
        console.log("[LOG] 5. Starting PASS 2: Applying effect from WAV and encoding to MP4...");
        await new Promise((resolve, reject) => {
            ffmpeg(sanitizedWavPath) // Input is the clean WAV file
                .audioCodec('aac')
                .audioFrequency(44100)
                .audioFilter('asetrate=44100*0.8,atempo=1.25') // The voice effect
                .audioBitrate(128)
                .on('end', () => {
                    console.log("[LOG] 5. PASS 2: Effect and encoding finished successfully.");
                    resolve();
                })
                .on('error', (err) => {
                    console.error("[ERROR] 5. PASS 2: FFmpeg error during effect application.", err);
                    reject(new Error(`FFmpeg effect/encoding failed: ${err.message}`));
                })
                .save(finalMp4Path);
        });

        // --- 6. Upload Final File ---
        console.log(`[LOG] 6. Uploading final processed file to gs://${bucketName}/${finalGcsPath}...`);
        const [uploadedFile] = await storage.bucket(bucketName).upload(finalMp4Path, {
            destination: finalGcsPath,
            metadata: { contentType: 'audio/mp4' },
            public: true,
        });
        const finalUrl = uploadedFile.publicUrl();
        console.log(`[LOG] 6. Upload successful. Final URL: ${finalUrl}`);
        
        // --- 7. Success ---
        console.log("--- TRANSCODE-AUDIO V3 FINISHED SUCCESSFULLY ---");
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Audio processed successfully!',
                transcodedGcsUrl: finalUrl,
            }),
        };

    } catch (error) {
        console.error("[FATAL ERROR] An error occurred in the main try/catch block.", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process audio.', details: error.message }),
        };
    } finally {
        // --- 8. Cleanup ---
        console.log("[LOG] 8. Cleaning up temporary files...");
        for (const filePath of filesToCleanup) {
            try {
                await fs.unlink(filePath);
                console.log(`[LOG] 8. Deleted: ${filePath}`);
            } catch (e) {
                // Ignore errors if file doesn't exist, but log others
                if (e.code !== 'ENOENT') {
                    console.warn(`[WARN] 8. Failed to clean up temp file ${filePath}: ${e.message}`);
                }
            }
        }
        console.log("--- TRANSCODE-AUDIO V3 CLEANUP COMPLETE ---");
    }
};