const ATTENDANCE_LABELS = {
  yes: 'Катышат',
  no: 'Катыша албайт',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { telegramChatId, guestName, attendance } = payload;
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
  const text = `Жаңы RSVP\n\nАты-жөнү: ${guestName}\nКатышуу: ${attendanceLabel}`;

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
