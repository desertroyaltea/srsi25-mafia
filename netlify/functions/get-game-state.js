// netlify/functions/get-game-state.js

// This is a minimal version to test if *any* logging works.
// We will build it back up once we see this log.

exports.handler = async (event, context) => {
    try {
        console.log('--- get-game-state.js: Function started (Minimal Version) ---');
        
        // This will attempt to access an environment variable. If GOOGLE_SHEET_ID is missing or malformed,
        // it might still crash here, but we're trying to get a log before that.
        const testSheetId = process.env.GOOGLE_SHEET_ID || 'NOT_SET';
        console.log(`Test: GOOGLE_SHEET_ID is: ${testSheetId}`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({ message: 'Minimal function response. Check logs for details.' }),
        };

    } catch (error) {
        console.error('--- get-game-state.js: UNEXPECTED ERROR (Minimal Version) ---', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Minimal function failed unexpectedly.' }),
        };
    }
};
