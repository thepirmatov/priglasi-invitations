const { getBlobStore } = require('./lib/blobs');
const { getClientIp, checkRateLimit, isAllowedOrigin, getCorsHeaders } = require('./lib/security');
const { appendRow } = require('./lib/google-sheets');

const ATTENDANCE_LABELS = {
  yes: 'Катышат',
  no: 'Катыша албайт',
};

// Every deployed customer site calls this from its own *.netlify.app subdomain (see
// README "Why each customer site is self-contained"), so same-origin alone isn't enough here.
// NOTE: if a couple's site later gets a custom domain, this needs updating.
const ALLOWED_DOMAINS = ['netlify.app'];

// Each order gets its own spreadsheet (see deploy-site-background.js's
// createRsvpSheet and the README) - orderId is what finds it.
const SHEET_RANGE = 'RSVPs!A:E';

exports.handler = async (event) => {
  // A JSON POST body is a cross-origin "preflighted" request - the browser
  // sends this OPTIONS request first and won't send the real POST at all
  // unless it sees CORS headers here approving the caller's origin.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: getCorsHeaders(event, ALLOWED_DOMAINS), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const corsHeaders = getCorsHeaders(event, ALLOWED_DOMAINS);

  if (!isAllowedOrigin(event, ALLOWED_DOMAINS)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const withinLimit = await checkRateLimit(`rsvp:${getClientIp(event)}`, { limit: 15, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, headers: corsHeaders, body: JSON.stringify({ error: 'Too many requests, try again later' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { orderId, guestName, attendance, guestCount, side } = payload;
  if (!orderId || !guestName || !attendance) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'orderId, guestName, and attendance are required' }),
    };
  }

  // Looked up server-side (not trusting a client-supplied sheet id) - also
  // means an order deployed before this feature existed, or one whose sheet
  // creation failed (best-effort - see createRsvpSheet), fails clearly here
  // instead of silently writing to the wrong place.
  const order = await getBlobStore('orders').get(orderId, { type: 'json' });
  if (!order || !order.sheetId) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'No RSVP sheet found for this order' }) };
  }

  const attendanceLabel = ATTENDANCE_LABELS[attendance] || attendance;
  // guestCount/side only arrive from templates with the guest-count stepper /
  // bride-groom side picker (see setupGuestCountStepper in template-core.js).
  const row = [new Date().toISOString(), guestName, attendanceLabel, guestCount || '', side || ''];

  try {
    await appendRow(order.sheetId, SHEET_RANGE, row);
  } catch (err) {
    console.error('Sheets append failed:', err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to save RSVP' }) };
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
};
