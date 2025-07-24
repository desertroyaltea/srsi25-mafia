    // netlify/functions/get-game-state.js

    const { google } = require('googleapis');
    const { JWT } = require('google-auth-library');

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const sheetId = process.env.GOOGLE_SHEET_ID;

    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // Read-only access to sheets
    });

    const sheets = google.sheets({ version: 'v4', auth });

    exports.handler = async (event, context) => {
        try {
            if (!sheetId) {
                console.error('Configuration Error: Google Sheet ID is not configured.');
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Server configuration error: Google Sheet ID missing.' }),
                };
            }

            const range = 'Game_State!A1:G2'; // Reads columns A to G from the Game_State tab

            console.log(`Attempting to fetch data from Sheet ID: ${sheetId}, Range: ${range}`);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: sheetId,
                range: range,
            });

            const values = response.data.values;
            console.log('Raw values from sheet (Game_State):', values);

            if (!values || values.length < 2) {
                console.log('No game state data or only headers found. Returning 404.');
                return {
                    statusCode: 404,
                    body: JSON.stringify({ message: 'Game state data not found or sheet is empty.' }),
                };
            }

            const headers = values[0];
            const gameStateData = values[1];

            const gameState = {};
            headers.forEach((header, index) => {
                const cleanHeader = header.replace(/[^a-zA-Z0-9]/g, '');
                gameState[cleanHeader] = gameStateData[index];
            });

            console.log('Parsed Game State:', gameState);

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
                body: JSON.stringify(gameState),
            };

        } catch (error) {
            console.error('Server Error: Failed to fetch game state:', error);
            let errorMessage = 'Failed to fetch game state.';
            if (error.response && error.response.data && error.response.data.error) {
                errorMessage = `Google API Error: ${error.response.data.error.message || error.message}`;
                console.error('Google API Error Details:', error.response.data.error);
            } else if (error.message) {
                errorMessage = `Internal Server Error: ${error.message}`;
            }
            return {
                statusCode: 500,
                body: JSON.stringify({ error: errorMessage }),
            };
        }
    };
    