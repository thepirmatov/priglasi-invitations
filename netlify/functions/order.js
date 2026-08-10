const { getStore } = require('@netlify/blobs');
const { getClientIp, checkRateLimit, isAllowedOrigin } = require('./lib/security');

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
  return required.filter(([, value]) => !value).map(([field]) => field);
}

function formatOrderMessage(payload) {
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
    `#ORD_${orderId}`,
  ].join('\n');
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const missing = validate(payload);
  if (missing.length > 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields', missing }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!botToken || !managerChatId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN / MANAGER_CHAT_ID not configured' }) };
  }

  const store = getStore('orders');
  await store.setJSON(payload.orderId, {
    ...payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: managerChatId, text: formatOrderMessage(payload) }),
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
