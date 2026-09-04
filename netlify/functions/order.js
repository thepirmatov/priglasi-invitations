const { getBlobStore } = require('./lib/blobs');
const { getClientIp, checkRateLimit, isAllowedOrigin, getCorsHeaders } = require('./lib/security');
const { validateOrderPayload } = require('./lib/orderValidation');

// Mirrors the client-side cap in public/storefront/app.js - a direct API call
// bypasses that check, so it's enforced again here.
const MAX_PAYLOAD_BYTES = 5.5 * 1024 * 1024;

// Unset (default) means the storefront and this function are still on the
// same Netlify site, so same-origin alone covers it - isAllowedOrigin/
// getCorsHeaders below fall back to exactly today's behavior. Set this to the
// bare domain (no scheme, e.g. "priglasi.com") once the storefront moves to
// its own host (see README) - no other change needed at that point.
const ALLOWED_DOMAINS = process.env.STOREFRONT_ORIGIN ? [process.env.STOREFRONT_ORIGIN] : [];

function formatOrderMessage(payload, orderViewUrl, editUrl) {
  const { orderId, templateId, config, customer } = payload;
  return [
    'Жаңы буйрутма',
    '',
    `Аты-жөнү: ${config.coupleNames}`,
    `Шаблон: ${templateId}`,
    `Күнү: ${config.date}${config.time ? ' ' + config.time : ''}`,
    `Жайгашкан жери: ${config.venueName}`,
    `Кардар: ${customer.name} (${customer.contact})`,
    '',
    `Толук маалымат жана сүрөттөр: ${orderViewUrl}`,
    // Works even before this order is deployed - order-edit.js just updates
    // the stored config in place until then (see there).
    `Чоңдоо шилтемеси (кардарга жиберүү үчүн): ${editUrl}`,
    '',
    `#ORD_${orderId}`,
  ].join('\n');
}

// Pre-filled into the customer's own WhatsApp compose box (wa.me only supports
// text, never attachments - see order-view.js for how photos reach the manager
// instead), so this reads as something the customer would actually send, not
// as an internal notification.
function formatWhatsAppMessage(payload, orderViewUrl) {
  const { orderId, templateId, config, customer } = payload;
  return [
    'Салам! Мен сайт аркылуу чакырууга буйрутма таштадым.',
    '',
    `Аты-жөнү: ${config.coupleNames}`,
    `Шаблон: ${templateId}`,
    `Күнү: ${config.date}${config.time ? ' ' + config.time : ''}`,
    `Жайгашкан жери: ${config.venueName}`,
    `Байланыш: ${customer.name} (${customer.contact})`,
    '',
    `Толук маалымат жана сүрөттөр: ${orderViewUrl}`,
    '',
    `#ORD_${orderId}`,
  ].join('\n');
}

function buildWhatsAppUrl(number, text) {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

exports.handler = async (event) => {
  // A JSON POST body is a cross-origin "preflighted" request - the browser
  // sends this OPTIONS request first and won't send the real POST at all
  // unless it sees CORS headers here approving the caller's origin. A no-op
  // until STOREFRONT_ORIGIN is set (see ALLOWED_DOMAINS above).
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: getCorsHeaders(event, ALLOWED_DOMAINS), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const corsHeaders = getCorsHeaders(event, ALLOWED_DOMAINS);

  // Orders only ever come from the storefront itself, so any other Origin is rejected outright.
  if (!isAllowedOrigin(event, ALLOWED_DOMAINS)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const withinLimit = await checkRateLimit(`order:${getClientIp(event)}`, { limit: 5, windowMs: 15 * 60 * 1000 });
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

  // MANAGER_WHATSAPP_NUMBER is the switch: unset (the default today) keeps the
  // original Telegram-only flow below; set it (if Telegram ever becomes
  // unreachable in-country - see README) and this becomes WhatsApp-primary
  // with Telegram demoted to a best-effort backup, no other code changes needed.
  const managerWhatsAppNumber = process.env.MANAGER_WHATSAPP_NUMBER;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!managerWhatsAppNumber && (!botToken || !managerChatId)) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN / MANAGER_CHAT_ID not configured' }) };
  }

  const store = getBlobStore('orders');
  await store.setJSON(payload.orderId, {
    ...payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const orderViewUrl = `${process.env.URL}/.netlify/functions/order-view?orderId=${payload.orderId}`;
  const editUrl = `${process.env.URL}/storefront/?orderId=${payload.orderId}`;

  if (managerWhatsAppNumber) {
    const whatsappUrl = buildWhatsAppUrl(managerWhatsAppNumber, formatWhatsAppMessage(payload, orderViewUrl));
    if (botToken && managerChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: managerChatId, text: formatOrderMessage(payload, orderViewUrl, editUrl) }),
        });
      } catch (err) {
        console.error('Telegram backup notification failed:', err);
      }
    }
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ orderId: payload.orderId, whatsappUrl }) };
  }

  const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: managerChatId, text: formatOrderMessage(payload, orderViewUrl, editUrl) }),
  });
  if (!telegramResponse.ok) {
    const errorBody = await telegramResponse.text();
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Order stored but failed to notify manager', details: errorBody }),
    };
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ orderId: payload.orderId }) };
};
