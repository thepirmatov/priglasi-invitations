const { getStore } = require('@netlify/blobs');

const ORDER_ID_PATTERN = /#ORD_([\w-]+)/;
const COMMAND_PATTERN = /^\/(bashta|create)\b/;

async function sendReply(botToken, chatId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 200, body: 'ok' };
  }

  const message = update.message;
  if (!message || !message.text || !COMMAND_PATTERN.test(message.text.trim())) {
    return { statusCode: 200, body: 'ok' };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const managerIds = (process.env.MANAGER_TELEGRAM_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const senderId = String((message.from && message.from.id) || '');
  const reply = (text) => sendReply(botToken, message.chat.id, message.message_id, text);

  // Authorization boundary for the whole deploy pipeline - must run before anything else.
  if (!managerIds.includes(senderId)) {
    await reply('Уруксат жок.');
    return { statusCode: 200, body: 'ok' };
  }

  const repliedText = message.reply_to_message && message.reply_to_message.text;
  const match = repliedText && repliedText.match(ORDER_ID_PATTERN);
  if (!match) {
    await reply('Буйрутма билдирүүсүнө жооп (reply) катары /bashta жазыңыз.');
    return { statusCode: 200, body: 'ok' };
  }
  const orderId = match[1];

  const store = getStore('orders');
  const order = await store.get(orderId, { type: 'json' });
  if (!order) {
    await reply(`Буйрутма табылган жок: ${orderId}`);
    return { statusCode: 200, body: 'ok' };
  }
  if (order.status !== 'pending') {
    await reply(`Бул буйрутма мурда иштелген (status: ${order.status}).`);
    return { statusCode: 200, body: 'ok' };
  }

  // Mark in-progress immediately to narrow the race window against a duplicate /bashta.
  await store.setJSON(orderId, { ...order, status: 'in_progress' });
  await reply('Даярдалууда...');

  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  await fetch(`${siteUrl}/.netlify/functions/deploy-site-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, chatId: message.chat.id, replyToMessageId: message.message_id }),
  });

  return { statusCode: 200, body: 'ok' };
};
