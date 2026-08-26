const { getStore } = require('@netlify/blobs');
const { getClientIp, checkRateLimit, isSafeImageUrl, isSafeAudioUrl, isSafeHttpsUrl } = require('./lib/security');

const STATUS_LABELS = {
  pending: 'Күтүлүүдө',
  in_progress: 'Даярдалууда',
  completed: 'Даяр',
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function renderPhotoGrid(photos) {
  const safe = (photos || []).filter(isSafeImageUrl);
  if (!safe.length) return '';
  const items = safe.map((url) => `<img src="${escapeHtml(url)}" alt="" />`).join('');
  return `<h2>Сүрөттөр</h2><div class="photo-grid">${items}</div>`;
}

function renderRow(label, value) {
  if (!value) return '';
  return `<div class="row"><span class="row-label">${escapeHtml(label)}</span><span class="row-value">${escapeHtml(value)}</span></div>`;
}

function renderOrderHtml(order) {
  const config = order.config || {};
  const customer = order.customer || {};
  const statusLabel = STATUS_LABELS[order.status] || order.status;

  const mapLine = config.mapUrl && isSafeHttpsUrl(config.mapUrl)
    ? `<div class="row"><span class="row-label">Карта</span><span class="row-value"><a href="${escapeHtml(config.mapUrl)}" target="_blank" rel="noopener">Картаны ачуу</a></span></div>`
    : '';

  const scheduleLines = Array.isArray(config.schedule)
    ? config.schedule.filter((row) => row && row.time && row.label)
      .map((row) => `<li>${escapeHtml(row.time)} — ${escapeHtml(row.label)}</li>`).join('')
    : '';
  const scheduleBlock = scheduleLines ? `<h2>Программа</h2><ul class="schedule-list">${scheduleLines}</ul>` : '';

  const musicBlock = config.musicUrl && isSafeAudioUrl(config.musicUrl)
    ? `<h2>Ыр</h2><audio controls src="${escapeHtml(config.musicUrl)}"></audio>`
    : '';

  const heroBlock = config.heroPhotoUrl && isSafeImageUrl(config.heroPhotoUrl)
    ? `<img class="hero-photo" src="${escapeHtml(config.heroPhotoUrl)}" alt="" />`
    : '';

  const siteLine = order.status === 'completed' && order.siteUrl
    ? `<div class="row"><span class="row-label">Даяр сайт</span><span class="row-value"><a href="${escapeHtml(order.siteUrl)}" target="_blank" rel="noopener">${escapeHtml(order.siteUrl)}</a></span></div>`
    : '';

  return `<!doctype html>
<html lang="ky">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Буйрутма ${escapeHtml(order.orderId)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f5f2; color: #2b2420; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
  .status { display: inline-block; padding: 0.3rem 0.8rem; border-radius: 999px; background: #8a6d5c; color: #fff; font-size: 0.8rem; font-weight: 600; }
  .hero-photo { display: block; width: 100%; border-radius: 16px; margin: 1rem 0; aspect-ratio: 390 / 844; object-fit: cover; background: #eee; }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid #ece5dc; font-size: 0.9rem; }
  .row-label { color: #6b5d52; flex: 0 0 auto; }
  .row-value { text-align: right; }
  .row-value a { color: #8a6d5c; }
  .photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
  .photo-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: #eee; }
  .schedule-list { margin: 0; padding-left: 1.2rem; font-size: 0.9rem; }
  audio { width: 100%; }
</style>
</head>
<body>
  <div class="wrap">
    <span class="status">${escapeHtml(statusLabel)}</span>
    <h1>${escapeHtml(config.coupleNames)}</h1>
    ${heroBlock}
    <div class="row"><span class="row-label">Шаблон</span><span class="row-value">${escapeHtml(order.templateId)}</span></div>
    ${renderRow('Күнү', `${config.date || ''}${config.time ? ' ' + config.time : ''}`)}
    ${renderRow('Жайгашкан жери', config.venueName)}
    ${renderRow('Дареги', config.venueAddress)}
    ${mapLine}
    ${renderRow('Дресс-код', config.dressCode)}
    ${renderRow('Тойдун ээлери', config.hostsNames)}
    ${renderRow('Кардар', customer.name)}
    ${renderRow('Байланыш', customer.contact)}
    ${siteLine}
    ${scheduleBlock}
    ${renderPhotoGrid(config.collagePhotos)}
    ${musicBlock}
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Only defense-in-depth (the order id itself is an unguessable UUID, same
  // trust model the Telegram /bashta flow already relies on) - slows down any
  // attempt to enumerate/brute-force order ids against this endpoint.
  const withinLimit = await checkRateLimit(`order-view:${getClientIp(event)}`, { limit: 60, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, body: 'Too many requests, try again later' };
  }

  const orderId = event.queryStringParameters && event.queryStringParameters.orderId;
  if (!orderId) {
    return { statusCode: 400, body: 'Missing orderId' };
  }

  const store = getStore('orders');
  const order = await store.get(orderId, { type: 'json' });
  if (!order) {
    return { statusCode: 404, body: 'Order not found' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: renderOrderHtml(order),
  };
};
