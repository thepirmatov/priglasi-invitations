const { getBlobStore } = require('./lib/blobs');
const { getClientIp, checkRateLimit, isAllowedOrigin, getCorsHeaders } = require('./lib/security');
const { validateOrderPayload } = require('./lib/orderValidation');

// Mirrors order.js's own cap - see the comment there.
const MAX_PAYLOAD_BYTES = 5.5 * 1024 * 1024;

// Same trust model as order-view.js and rsvp.js: the orderId itself (an
// unguessable short code, see app.js's generateOrderId) is the only
// credential - whoever holds the link the manager forwards them can view and
// edit their own order, no separate login needed.
const ALLOWED_DOMAINS = process.env.STOREFRONT_ORIGIN ? [process.env.STOREFRONT_ORIGIN] : [];

async function handleGet(event, corsHeaders) {
  if (!isAllowedOrigin(event, ALLOWED_DOMAINS)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }
  const orderId = event.queryStringParameters && event.queryStringParameters.orderId;
  if (!orderId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'orderId required' }) };
  }

  const withinLimit = await checkRateLimit(`order-edit-get:${getClientIp(event)}`, { limit: 30, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, headers: corsHeaders, body: JSON.stringify({ error: 'Too many requests, try again later' }) };
  }

  const store = getBlobStore('orders');
  const order = await store.get(orderId, { type: 'json' });
  if (!order) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Order not found' }) };
  }
  if (order.status === 'in_progress') {
    return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: 'Order is currently deploying' }) };
  }

  // draft (the wizard's own raw per-field snapshot, saved alongside the
  // computed `config` since app.js's submit handler - see there) is what lets
  // the wizard pre-fill itself exactly like resuming a local draft does.
  // Older orders placed before this feature existed won't have one.
  if (!order.draft) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'This order predates online editing' }) };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      status: order.status,
      category: order.category,
      templateId: order.templateId,
      draft: order.draft,
    }),
  };
}

async function handlePost(event, corsHeaders) {
  if (!isAllowedOrigin(event, ALLOWED_DOMAINS)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const withinLimit = await checkRateLimit(`order-edit-post:${getClientIp(event)}`, { limit: 5, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, headers: corsHeaders, body: JSON.stringify({ error: 'Too many requests, try again later' }) };
  }

  const rawBody = event.body || '';
  const bodyBytes = event.isBase64Encoded ? Buffer.byteLength(rawBody, 'base64') : Buffer.byteLength(rawBody, 'utf8');
  if (bodyBytes > MAX_PAYLOAD_BYTES) {
    return { statusCode: 413, headers: corsHeaders, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (err) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { missing, invalid } = validateOrderPayload(payload);
  if (missing.length > 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing required fields', missing }) };
  }
  if (invalid.length > 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid fields', invalid }) };
  }

  const store = getBlobStore('orders');
  const existing = await store.get(payload.orderId, { type: 'json' });
  if (!existing) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Order not found' }) };
  }
  if (existing.status === 'in_progress') {
    return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: 'Order is currently deploying' }) };
  }

  const updated = {
    ...existing,
    templateId: payload.templateId,
    category: payload.category,
    config: payload.config,
    customer: payload.customer,
    draft: payload.draft || existing.draft,
    revisionCount: (existing.revisionCount || 0) + 1,
    lastEditedAt: new Date().toISOString(),
  };
  await store.setJSON(payload.orderId, updated);

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const managerChatId = process.env.MANAGER_CHAT_ID;

  // Not deployed yet - nothing to redeploy, the manager's next /bashta will
  // simply pick up this newer config. Just let them know it changed.
  if (existing.status !== 'completed') {
    if (botToken && managerChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: managerChatId,
            text: `Буйрутма өзгөртүлдү (деплой болгон эмес): ${updated.config.coupleNames}\n#ORD_${payload.orderId}`,
          }),
        });
      } catch (err) {
        console.error('order-edit: Telegram notify (pending) failed:', err);
      }
    }
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ orderId: payload.orderId, redeploying: false }) };
  }

  // Already deployed - push the edit live by redeploying to the *same* site
  // (see the `mode: 'redeploy'` branch in deploy-site-background.js) instead
  // of creating a new one, so an edit never spends another site slot.
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const secret = process.env.INTERNAL_FUNCTION_SECRET || '';
  try {
    const triggerRes = await fetch(`${siteUrl}/.netlify/functions/deploy-site-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ orderId: payload.orderId, chatId: managerChatId, mode: 'redeploy' }),
    });
    if (!triggerRes.ok) {
      console.error(`order-edit: redeploy trigger failed: ${triggerRes.status} ${await triggerRes.text()}`);
    }
  } catch (err) {
    console.error('order-edit: redeploy trigger request failed:', err);
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ orderId: payload.orderId, redeploying: true }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: getCorsHeaders(event, ALLOWED_DOMAINS), body: '' };
  }
  const corsHeaders = getCorsHeaders(event, ALLOWED_DOMAINS);

  if (event.httpMethod === 'GET') return handleGet(event, corsHeaders);
  if (event.httpMethod === 'POST') return handlePost(event, corsHeaders);
  return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
};
