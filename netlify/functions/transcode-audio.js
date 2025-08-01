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
        credentials,
    });
} catch (e) {
    storage = null;
}

exports.handler = async (event) => {
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
        originalGcsUrl = JSON.parse(event.body).originalGcsUrl;
        if (!originalGcsUrl) throw new Error("Missing originalGcsUrl");
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
    }

    const urlParts = originalGcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)/);
    if (!urlParts) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid GCS URL provided.' }) };
    }

    const originalGcsPath = urlParts[2];
    const originalFileName = path.basename(originalGcsPath);
    const tempDir = os.tmpdir();
    
    const inputFilePath = path.join(tempDir, `original_${originalFileName}`);
    const finalMp4Path = path.join(tempDir, `${path.parse(originalFileName).name}_masked.mp4`);
    const finalGcsPath = `accusations/${path.basename(finalMp4Path)}`;

    const filesToCleanup = [inputFilePath, finalMp4Path];

    try {
        await storage.bucket(bucketName).file(originalGcsPath).download({ destination: inputFilePath });
        
        await new Promise((resolve, reject) => {
            ffmpeg(inputFilePath)
                .noVideo() // Ignore any video tracks
                .audioCodec('aac')
                .audioBitrate(128)
                // Applying the stable robotic effect
.audioFilter('asetrate=44100*0.8,atempo=1.25')
                .output(finalMp4Path)
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg transcoding failed: ${err.message}`)))
                .run();
        });

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
        console.error("Transcode Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process audio.', details: error.message }) };
    } finally {
        for (const filePath of filesToCleanup) {
            try { await fs.unlink(filePath); } catch (e) {
                if (e.code !== 'ENOENT') console.warn(`Cleanup failed for ${filePath}: ${e.message}`);
            }
        }
    }
};