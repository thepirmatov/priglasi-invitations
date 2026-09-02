// Cached across warm invocations of the same function instance - harmless to
// lose on a cold start (just re-authenticates), same best-effort spirit as
// the rate-limit/order-status checks elsewhere in netlify/functions/lib.
let cachedToken = null;

// Authenticates as your own Google account (not a service account) via a
// long-lived OAuth refresh token - see README. A bare service account can
// never own a Drive file (confirmed by Google support: it has zero storage
// quota and stays the owner of anything it creates, even inside a folder you
// share with it), and the two ways around that - Shared Drives and
// domain-wide delegation - both require paid Google Workspace, unavailable
// on a personal Gmail account. Authenticating as you directly sidesteps the
// whole problem: files this mints are yours from the start, spending your
// real 15GB quota, no service account or sharing step involved.
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
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
// "RSVPs" sheet, a header row, and a live per-side attendee count block
// (columns G-I) next to it. Returns { spreadsheetId, spreadsheetUrl }.
//
// nameA/nameB (bride/groom, or whichever two sides the couple picked - see
// deploy-site-background.js) become both the count block's column headers
// and the two values that end up in the RSVPs tab's own "Тарап" column, so
// SUMIFS below always matches what guests actually submitted. folderId
// (GOOGLE_DRIVE_FOLDER_ID) is optional - purely for keeping these organized
// in your Drive, not required for correctness now that this authenticates
// as you directly.
async function createSpreadsheet(title, headerRow, nameA, nameB, folderId) {
  const accessToken = await getAccessToken();
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: folderId ? [folderId] : undefined,
    }),
  });
  if (!createRes.ok) throw new Error(`Sheets create failed: ${createRes.status} ${await createRes.text()}`);
  const { id: spreadsheetId, webViewLink: spreadsheetUrl } = await createRes.json();

  // One batchUpdate: renames the default (sheetId 0) tab a freshly created
  // spreadsheet always starts with - Drive API's files.create (unlike the
  // Sheets API's own spreadsheets.create) has no way to name that tab up
  // front - and bolds the count block's header/total cells.
  const batchRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, title: 'RSVPs' }, fields: 'title' } },
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 6, endColumnIndex: 9 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 8, endColumnIndex: 9 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.72, green: 0.88, blue: 0.72 } } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
      ],
    }),
  });
  if (!batchRes.ok) throw new Error(`Sheet formatting failed: ${batchRes.status} ${await batchRes.text()}`);

  // H1/I1 are static (the two side names never change); H2/I2/I3 are live
  // formulas so the count updates itself as rsvp.js appends more rows -
  // COUNTIFS(side, attending) rather than SUMIFS(guestCount): guests who
  // decline leave guestCount blank, and each row is one RSVP regardless of
  // how many people it covers, so a plain count of matching rows is what
  // "Келет" (how many are coming) actually means here.
  await appendValues(accessToken, spreadsheetId, 'RSVPs!G1:I3', [
    ['', nameA || '', nameB || ''],
    ['Келет', '=COUNTIFS(E:E,H1,C:C,"Катышат")', '=COUNTIFS(E:E,I1,C:C,"Катышат")'],
    ['Баары', '', '=H2+I2'],
  ]);

  await appendRow(spreadsheetId, 'RSVPs!A:E', headerRow);

  return { spreadsheetId, spreadsheetUrl };
}

// Writes a fixed range with USER_ENTERED so formula strings (the count
// block's =COUNTIFS(...) cells above) are evaluated instead of stored as
// literal text - update (not append), since these are specific, reusable cells.
async function appendValues(accessToken, spreadsheetId, range, rows) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`Sheets count-block write failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { appendRow, createSpreadsheet };
