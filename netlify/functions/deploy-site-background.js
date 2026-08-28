const { getBlobStore } = require('./lib/blobs');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createSpreadsheet, shareSpreadsheet } = require('./lib/google-sheets');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'public', 'templates');
const SHARED_DIR = path.join(__dirname, '..', '..', 'public', 'shared');
const SHARED_CORE_PATH = path.join(SHARED_DIR, 'template-core.js');
const SHARED_DECOR_JS_PATH = path.join(SHARED_DIR, 'decor.js');
const SHARED_DECOR_CSS_PATH = path.join(SHARED_DIR, 'decor.css');
const HTML2CANVAS_PATH = path.join(SHARED_DIR, 'vendor', 'html2canvas.min.js');

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

async function buildDeployZip(templateId, config, orderId) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);
  let html = fs.readFileSync(path.join(templateDir, 'index.html'), 'utf8');
  // Templates reference shared/ two directories up for local dev; the deploy
  // bundle is flat, so rewrite every shared/ path to sit next to index.html.
  html = html
    .replace('../../shared/template-core.js', 'template-core.js')
    .replace('../../shared/decor.js', 'decor.js')
    .replace('../../shared/decor.css', 'decor.css')
    .replace('../../shared/vendor/html2canvas.min.js', 'html2canvas.min.js');
  const css = fs.readFileSync(path.join(templateDir, 'styles.css'), 'utf8');
  const coreJs = fs.readFileSync(SHARED_CORE_PATH, 'utf8');
  const decorJs = fs.readFileSync(SHARED_DECOR_JS_PATH, 'utf8');
  const decorCss = fs.readFileSync(SHARED_DECOR_CSS_PATH, 'utf8');
  // Only the templates with the guest-card-download capability (see
  // setupGuestCard in template-core.js) reference html2canvas, so only bundle
  // this ~190KB vendor file into their deploy zip, not every customer's site.
  const needsHtml2Canvas = html.includes('html2canvas.min.js');

  // This deployed site has no netlify/functions of its own (see comment on
  // rsvpEndpoint below), so config.json must carry an absolute endpoint
  // pointing back at the main storefront site's rsvp function. orderId rides
  // along too - rsvp.js needs it to tag which couple's Google Sheet rows are whose.
  const configWithRsvp = { ...config, orderId, rsvpEndpoint: `${process.env.URL}/.netlify/functions/rsvp` };

  const zip = new JSZip();
  zip.file('index.html', html);
  zip.file('styles.css', css);
  zip.file('template-core.js', coreJs);
  zip.file('decor.js', decorJs);
  zip.file('decor.css', decorCss);
  if (needsHtml2Canvas) zip.file('html2canvas.min.js', fs.readFileSync(HTML2CANVAS_PATH));
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

// One Google Sheet per order (not shared across couples - see README), so the
// couple's own RSVP data can be handed to them directly (email or link) with
// no risk of exposing anyone else's guest list. Best-effort: this must never
// take down a deploy that otherwise succeeded, so callers catch and continue.
async function createRsvpSheet(coupleNames, orderId) {
  const managerEmail = process.env.MANAGER_GOOGLE_EMAIL;
  if (!managerEmail || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;

  const title = `RSVP - ${coupleNames} - ${orderId.slice(0, 8)}`;
  const header = ['Убакыт', 'Конок', 'Катышуу', 'Конок саны', 'Тарап'];
  const { spreadsheetId, spreadsheetUrl } = await createSpreadsheet(title, header);
  // The sheet is created inside the service account's own Drive space -
  // invisible to you until it's shared with your own Google account.
  await shareSpreadsheet(spreadsheetId, managerEmail, 'writer');
  return { sheetId: spreadsheetId, sheetUrl: spreadsheetUrl };
}

async function sendTelegramMessage(botToken, chatId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
  });
}

exports.handler = async (event) => {
  // This endpoint is public (Netlify Functions have no built-in caller auth), and would
  // otherwise let anyone who sends a valid orderId trigger a live deploy + mark the order
  // "completed" without a manager ever approving payment. telegram-webhook.js (a manager's
  // /bashta reply) and scripts/deploy-order.js (you, after the manager confirms payment over
  // WhatsApp - see README) are the only legitimate callers, and both prove that by echoing
  // this shared secret.
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET;
  const providedSecret = event.headers && (event.headers['x-internal-secret'] || event.headers['X-Internal-Secret']);
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return { statusCode: 403, body: '' };
  }

  const { orderId, chatId, replyToMessageId } = JSON.parse(event.body || '{}');
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;
  const store = getBlobStore('orders');

  const order = await store.get(orderId, { type: 'json' });
  if (!order) {
    await sendTelegramMessage(botToken, chatId, replyToMessageId, `Буйрутма табылган жок: ${orderId}`);
    return { statusCode: 202, body: '' };
  }
  // Both the Telegram /bashta path and the manual deploy-order script can reach
  // this same function now, so this check - not either caller's own - is what
  // actually prevents a duplicate trigger from deploying (and billing) the same
  // order twice. Best-effort, not a strict guarantee (see checkRateLimit's same
  // caveat in lib/security.js): a get-then-set race is still possible if two
  // triggers land within milliseconds of each other, just very unlikely here.
  if (order.status !== 'pending') {
    await sendTelegramMessage(botToken, chatId, replyToMessageId, `Бул буйрутма мурда иштелген (status: ${order.status}).`);
    return { statusCode: 202, body: '' };
  }
  await store.setJSON(orderId, { ...order, status: 'in_progress' });

  try {
    const zipBuffer = await buildDeployZip(order.templateId, order.config, orderId);
    const slug = slugify(order.config.coupleNames, orderId);
    const site = await createNetlifySite(netlifyToken, slug);
    await deployToSite(netlifyToken, site.id, zipBuffer);

    let sheet = null;
    try {
      sheet = await createRsvpSheet(order.config.coupleNames, orderId);
    } catch (err) {
      console.error('RSVP sheet creation failed (site deploy still succeeded):', err);
    }

    const siteUrl = site.ssl_url || site.url;
    await store.setJSON(orderId, {
      ...order,
      status: 'completed',
      siteUrl,
      sheetId: sheet && sheet.sheetId,
      sheetUrl: sheet && sheet.sheetUrl,
      completedAt: new Date().toISOString(),
    });
    await sendTelegramMessage(
      botToken,
      chatId,
      replyToMessageId,
      `Даяр! ${siteUrl}${sheet ? `\nRSVP таблица: ${sheet.sheetUrl}` : ''}`
    );
  } catch (err) {
    console.error(err);
    await store.setJSON(orderId, { ...order, status: 'pending' });
    await sendTelegramMessage(botToken, chatId, replyToMessageId, `Ката кетти: ${err.message}\nКайра аракет кылуу үчүн /bashta жазыңыз же scripts/deploy-order.js.`);
  }

  return { statusCode: 202, body: '' };
};
