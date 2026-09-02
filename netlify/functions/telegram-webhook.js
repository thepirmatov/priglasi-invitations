const { getBlobStore } = require('./lib/blobs');

const ORDER_ID_PATTERN = /#ORD_([\w-]+)/;
const COMMAND_PATTERN = /^\/(bashta|create)\b/;
const ID_COMMAND_PATTERN = /^\/id\b/;

async function sendReply(botToken, chatId, replyToMessageId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
  });
  if (!res.ok) {
    console.error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
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
  if (!message || !message.text) {
    return { statusCode: 200, body: 'ok' };
  }
  const text = message.text.trim();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const reply = (replyText) => sendReply(botToken, message.chat.id, message.message_id, replyText);

  // No auth check: this is how you find the ids to put in MANAGER_TELEGRAM_IDS /
  // MANAGER_CHAT_ID in the first place, so it can't itself require being listed
  // there yet - works for anyone, in a DM or a group, same as /bashta's own
  // reply-to-message-id targeting.
  if (ID_COMMAND_PATTERN.test(text)) {
    const senderId = (message.from && message.from.id) || 'белгисиз';
    await reply(`Сиздин Telegram ID: ${senderId}\nБул чаттын ID: ${message.chat.id}`);
    return { statusCode: 200, body: 'ok' };
  }

  if (!COMMAND_PATTERN.test(text)) {
    return { statusCode: 200, body: 'ok' };
  }

  const managerIds = (process.env.MANAGER_TELEGRAM_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const senderId = String((message.from && message.from.id) || '');

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

  const store = getBlobStore('orders');
  const order = await store.get(orderId, { type: 'json' });
  if (!order) {
    await reply(`Буйрутма табылган жок: ${orderId}`);
    return { statusCode: 200, body: 'ok' };
  }
  if (order.status !== 'pending') {
    await reply(`Бул буйрутма мурда иштелген (status: ${order.status}).`);
    return { statusCode: 200, body: 'ok' };
  }

  // deploy-site-background.js (not here) is what actually marks the order
  // in_progress now - it's the single gate shared with scripts/deploy-order.js
  // (the manual WhatsApp-flow trigger, see README), so it's the only place
  // that can reliably catch a duplicate trigger from either path.
  await reply('Даярдалууда...');

  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  try {
    const triggerRes = await fetch(`${siteUrl}/.netlify/functions/deploy-site-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // deploy-site-background has no other way to tell a manager's approved /bashta
        // apart from anyone who POSTs a guessed/leaked orderId directly - see INTERNAL_FUNCTION_SECRET
        // in deploy-site-background.js.
        'X-Internal-Secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify({ orderId, chatId: message.chat.id, replyToMessageId: message.message_id }),
    });
    // A background function returns this 202 before its own body runs, so this
    // only ever catches the trigger request itself failing to land (wrong siteUrl,
    // the function route not existing, a network error) - not anything that goes
    // wrong inside deploy-site-background.js afterwards. Still better than the
    // silent stuck-at-"pending" order this used to leave behind either way.
    if (!triggerRes.ok) {
      console.error(`deploy-site-background trigger failed: ${triggerRes.status} ${await triggerRes.text()}`);
      await reply(`Ката кетти: фондук иштетүүнү баштоо мүмкүн болбоду (${triggerRes.status}).`);
    }
  } catch (err) {
    console.error('deploy-site-background trigger request failed:', err);
    await reply(`Ката кетти: фондук иштетүүнү баштоо мүмкүн болбоду (${err.message}).`);
  }

  return { statusCode: 200, body: 'ok' };
};
