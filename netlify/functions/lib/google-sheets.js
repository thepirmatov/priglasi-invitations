const crypto = require('crypto');

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cached across warm invocations of the same function instance - harmless to
// lose on a cold start (just re-authenticates), same best-effort spirit as
// the rate-limit/order-status checks elsewhere in netlify/functions/lib.
let cachedToken = null;

// Service accounts authenticate by self-signing a short-lived JWT (RS256)
// and exchanging it for an access token - no google-auth-library/googleapis
// dependency needed, Node's built-in crypto module signs RS256 natively.
// GOOGLE_SERVICE_ACCOUNT_KEY is the full JSON key file content (see README),
// stored as a single-line env var so its PEM private key's embedded newlines
// travel safely as the JSON string's own escaped "\n" rather than literal
// newlines, which Netlify's env var UI doesn't preserve reliably.
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: key.client_email,
    // spreadsheets: read/write cell data. drive.file (not the much broader
    // "drive" scope): manage sharing, but only for files this service account
    // itself created - it can't see or touch anything else in anyone's Drive.
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${res.status} ${JSON.stringify(data)}`);

  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

// Appends one row to `range` (e.g. "RSVPs!A:E") in the given spreadsheet.
// USER_ENTERED (not RAW) so Google parses the timestamp as a real date/time
// instead of storing it as a plain string.
async function appendRow(spreadsheetId, range, values) {
  const accessToken = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Creates a new spreadsheet (one per order - see README) with a single
// "RSVPs" sheet and a header row already written. Returns { spreadsheetId,
// spreadsheetUrl }. The spreadsheet is created inside the service account's
// own Drive space, invisible to anyone else until shareSpreadsheet is called.
async function createSpreadsheet(title, headerRow) {
  const accessToken = await getAccessToken();
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: 'RSVPs' } }],
    }),
  });
  if (!res.ok) throw new Error(`Sheets create failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  await appendRow(data.spreadsheetId, 'RSVPs!A:E', headerRow);

  return { spreadsheetId: data.spreadsheetId, spreadsheetUrl: data.spreadsheetUrl };
}

// Grants `role` ("writer" or "reader") on the spreadsheet to a specific
// email - the Sheets API itself doesn't manage sharing, that's Drive's job.
async function shareSpreadsheet(spreadsheetId, email, role = 'writer') {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role, emailAddress: email }),
  });
  if (!res.ok) throw new Error(`Sheets share failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { appendRow, createSpreadsheet, shareSpreadsheet };
