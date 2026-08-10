const { getClientIp, checkRateLimit, isAllowedOrigin } = require('./lib/security');

const ATTENDANCE_LABELS = {
  yes: 'Катышат',
  no: 'Катыша албайт',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Every deployed customer site calls this from its own *.netlify.app subdomain (see
  // README "Why each customer site is self-contained"), so same-origin alone isn't enough here.
  // NOTE: if a couple's site later gets a custom domain, this suffix check needs updating.
  if (!isAllowedOrigin(event, ['.netlify.app'])) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const withinLimit = await checkRateLimit(`rsvp:${getClientIp(event)}`, { limit: 15, windowMs: 15 * 60 * 1000 });
  if (!withinLimit) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests, try again later' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { telegramChatId, guestName, attendance, guestCount, side } = payload;
  if (!telegramChatId || !guestName || !attendance) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'telegramChatId, guestName, and attendance are required' }),
    };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN is not configured' }) };
  }

  const attendanceLabel = ATTENDANCE_LABELS[attendance] || attendance;
  // guestCount/side only arrive from templates with the guest-count stepper /
  // bride-groom side picker (see setupGuestCountStepper in template-core.js).
  const lines = [`Жаңы RSVP`, '', `Аты-жөнү: ${guestName}`, `Катышуу: ${attendanceLabel}`];
  if (guestCount) lines.push(`Конок саны: ${guestCount}`);
  if (side) lines.push(`Кимдин коногу: ${side}`);
  const text = lines.join('\n');

  const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: telegramChatId, text }),
  });

  if (!telegramResponse.ok) {
    const errorBody = await telegramResponse.text();
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to notify Telegram', details: errorBody }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
