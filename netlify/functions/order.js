const { getStore } = require('@netlify/blobs');
const { getClientIp, checkRateLimit, isAllowedOrigin, isSafeImageUrl, isSafeAudioUrl } = require('./lib/security');

// Mirrors the client-side cap in public/storefront/app.js - a direct API call
// bypasses that check, so it's enforced again here.
const MAX_PAYLOAD_BYTES = 5.5 * 1024 * 1024;
const MAX_COLLAGE_PHOTOS = 15;

function validate(payload) {
  const required = [
    ['orderId', payload.orderId],
    ['templateId', payload.templateId],
    ['category', payload.category],
    ['config.coupleNames', payload.config && payload.config.coupleNames],
    ['config.date', payload.config && payload.config.date],
    ['config.venueName', payload.config && payload.config.venueName],
    ['customer.name', payload.customer && payload.customer.name],
    ['customer.contact', payload.customer && payload.customer.contact],
  ];
  const missing = required.filter(([, value]) => !value).map(([field]) => field);

  const config = payload.config || {};
  const invalid = [];
  if (config.heroPhotoUrl && !isSafeImageUrl(config.heroPhotoUrl)) {
    invalid.push('config.heroPhotoUrl');
  }
  if (config.collagePhotos !== undefined) {
    if (!Array.isArray(config.collagePhotos) || config.collagePhotos.length > MAX_COLLAGE_PHOTOS) {
      invalid.push('config.collagePhotos');
    } else if (!config.collagePhotos.every(isSafeImageUrl)) {
      invalid.push('config.collagePhotos');
    }
  }
  if (config.musicUrl && !isSafeAudioUrl(config.musicUrl)) {
    invalid.push('config.musicUrl');
  }

  return { missing, invalid };
}

function formatOrderMessage(payload, orderViewUrl) {
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Orders only ever come from this storefront itself, so cross-site Origins are rejected outright.
  if (!isAllowedOrigin(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const withinLimit = await checkRateLimit(`order:${getClientIp(event)}`, { limit: 5, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests, try again later' }) };
  }

  const rawBody = event.body || '';
  const bodyBytes = event.isBase64Encoded ? Buffer.byteLength(rawBody, 'base64') : Buffer.byteLength(rawBody, 'utf8');
  if (bodyBytes > MAX_PAYLOAD_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { missing, invalid } = validate(payload);
  if (missing.length > 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields', missing }) };
  }
  if (invalid.length > 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid fields', invalid }) };
  }

  // MANAGER_WHATSAPP_NUMBER is the switch: unset (the default today) keeps the
  // original Telegram-only flow below; set it (if Telegram ever becomes
  // unreachable in-country - see README) and this becomes WhatsApp-primary
  // with Telegram demoted to a best-effort backup, no other code changes needed.
  const managerWhatsAppNumber = process.env.MANAGER_WHATSAPP_NUMBER;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!managerWhatsAppNumber && (!botToken || !managerChatId)) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN / MANAGER_CHAT_ID not configured' }) };
  }

  const store = getStore('orders');
  await store.setJSON(payload.orderId, {
    ...payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const orderViewUrl = `${process.env.URL}/.netlify/functions/order-view?orderId=${payload.orderId}`;

  if (managerWhatsAppNumber) {
    const whatsappUrl = buildWhatsAppUrl(managerWhatsAppNumber, formatWhatsAppMessage(payload, orderViewUrl));
    if (botToken && managerChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: managerChatId, text: formatOrderMessage(payload, orderViewUrl) }),
        });
      } catch (err) {
        console.error('Telegram backup notification failed:', err);
      }
    }
    return { statusCode: 200, body: JSON.stringify({ orderId: payload.orderId, whatsappUrl }) };
  }

  const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: managerChatId, text: formatOrderMessage(payload, orderViewUrl) }),
  });
  if (!telegramResponse.ok) {
    const errorBody = await telegramResponse.text();
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Order stored but failed to notify manager', details: errorBody }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ orderId: payload.orderId }) };
};
