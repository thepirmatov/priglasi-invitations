const { getStore } = require('@netlify/blobs');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'public', 'templates');
const SHARED_CORE_PATH = path.join(__dirname, '..', '..', 'public', 'shared', 'template-core.js');

// Kyrgyz/Russian Cyrillic -> Latin, since couple names (the basis for the
// subdomain slug) are almost always in Cyrillic and Netlify site names must
// be ASCII.
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ө: 'o', ү: 'u', ң: 'ng',
};

function slugify(str, orderId) {
  const transliterated = str
    .toLowerCase()
    .split('')
    .map((ch) => (ch in CYRILLIC_MAP ? CYRILLIC_MAP[ch] : ch))
    .join('');
  const base = transliterated.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'invitation';
  return `${base}-${orderId.slice(0, 6)}`;
}

async function buildDeployZip(templateId, config) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);
  let html = fs.readFileSync(path.join(templateDir, 'index.html'), 'utf8');
  // Templates reference the shared core two directories up for local dev;
  // the deploy bundle is flat, so rewrite the script path.
  html = html.replace('../../shared/template-core.js', 'template-core.js');
  const css = fs.readFileSync(path.join(templateDir, 'styles.css'), 'utf8');
  const coreJs = fs.readFileSync(SHARED_CORE_PATH, 'utf8');

  // This deployed site has no netlify/functions of its own (see comment on
  // rsvpEndpoint below), so config.json must carry an absolute endpoint
  // pointing back at the main storefront site's rsvp function.
  const configWithRsvp = { ...config, rsvpEndpoint: `${process.env.URL}/.netlify/functions/rsvp` };

  const zip = new JSZip();
  zip.file('index.html', html);
  zip.file('styles.css', css);
  zip.file('template-core.js', coreJs);
  zip.file('config.json', JSON.stringify(configWithRsvp, null, 2));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function createNetlifySite(authToken, name) {
  const res = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Netlify site creation failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deployToSite(authToken, siteId, zipBuffer) {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/zip' },
    body: zipBuffer,
  });
  if (!res.ok) throw new Error(`Netlify deploy failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendTelegramMessage(botToken, chatId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
  });
}

exports.handler = async (event) => {
  const { orderId, chatId, replyToMessageId } = JSON.parse(event.body || '{}');
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;
  const store = getStore('orders');

  try {
    const order = await store.get(orderId, { type: 'json' });
    if (!order) throw new Error(`Order not found: ${orderId}`);

    const zipBuffer = await buildDeployZip(order.templateId, order.config);
    const slug = slugify(order.config.coupleNames, orderId);
    const site = await createNetlifySite(netlifyToken, slug);
    await deployToSite(netlifyToken, site.id, zipBuffer);

    const siteUrl = site.ssl_url || site.url;
    await store.setJSON(orderId, { ...order, status: 'completed', siteUrl, completedAt: new Date().toISOString() });
    await sendTelegramMessage(botToken, chatId, replyToMessageId, `Даяр! ${siteUrl}`);
  } catch (err) {
    console.error(err);
    const order = await store.get(orderId, { type: 'json' });
    if (order) await store.setJSON(orderId, { ...order, status: 'pending' });
    await sendTelegramMessage(botToken, chatId, replyToMessageId, `Ката кетти: ${err.message}\nКайра аракет кылуу үчүн /bashta жазыңыз.`);
  }

  return { statusCode: 202, body: '' };
};
