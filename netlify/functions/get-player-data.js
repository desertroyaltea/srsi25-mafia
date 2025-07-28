// netlify/functions/get-player-data.js

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Helper function to initialize Google Sheets API
async function getSheetsService() {
 const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
 const auth = new JWT({
     email: credentials.client_email,
     key: credentials.private_key,
     scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
 });
 return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event, context) => {
 console.log("get-player-data: Function started."); // DEBUG LOG O
 if (event.httpMethod !== 'GET') {
     console.log("get-player-data: Method Not Allowed."); // DEBUG LOG P
     return { statusCode: 405, body: 'Method Not Allowed' };
 }

 const sheetId = process.env.GOOGLE_SHEET_ID;
 if (!sheetId) {
     console.error("get-player-data: Google Sheet ID is not configured."); // DEBUG LOG Q
     return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
 }
 console.log(`get-player-data: Sheet ID: ${sheetId}`); // DEBUG LOG R

 try {
     const sheets = await getSheetsService();
     console.log("get-player-data: Sheets service initialized."); // DEBUG LOG S

     const playersResponse = await sheets.spreadsheets.values.get({
         spreadsheetId: sheetId,
         range: 'Players!A:AA', // Fetch all columns as per previous setup
     });

     const allPlayersData = playersResponse.data.values || [];
     console.log("get-player-data: Raw data fetched from sheet:", JSON.stringify(allPlayersData)); // DEBUG LOG T

     if (allPlayersData.length < 1) {
         console.log("get-player-data: Players sheet is empty."); // DEBUG LOG U
         return { statusCode: 200, body: JSON.stringify([]) };
     }

     const headers = allPlayersData[0];
     const playerRows = allPlayersData.slice(1);

     const players = [];
     for (const row of playerRows) {
         const player = {};
         for (let i = 0; i < headers.length; i++) {
             // Ensure all values are converted to string for consistent comparison in frontend
             player[headers[i]] = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
         }
         players.push(player);
     }
     console.log("get-player-data: Parsed player data sent to frontend:", JSON.stringify(players)); // DEBUG LOG V

     return {
         statusCode: 200,
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(players),
     };

 } catch (error) {
     console.error('get-player-data: Error in try-catch block:', error); // DEBUG LOG W
     return {
         statusCode: 500,
         body: JSON.stringify({ error: 'Failed to fetch player data.', details: error.message }),
     };
 } finally {
     console.log("get-player-data: Function finished."); // DEBUG LOG X
 }
};