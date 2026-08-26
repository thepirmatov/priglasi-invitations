#!/usr/bin/env node
// Manually triggers a customer's deploy once the manager confirms payment over
// WhatsApp and tells you the order id - the same deploy-site-background.js
// this used to only be reachable via a manager's /bashta reply in Telegram
// (see README), now reachable directly since Telegram is no longer required
// for the sales flow.
//
// Usage: node scripts/deploy-order.js <orderId> [siteUrl]
//   siteUrl defaults to http://localhost:8888 (netlify dev's default port).
//   For a deployed site, pass its URL explicitly, e.g.:
//   node scripts/deploy-order.js abc-123 https://priglasi.netlify.app

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  });
}

async function main() {
  loadDotEnv();

  const orderId = process.argv[2];
  const siteUrl = process.argv[3] || 'http://localhost:8888';
  if (!orderId) {
    console.error('Usage: node scripts/deploy-order.js <orderId> [siteUrl]');
    process.exit(1);
  }

  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  if (!secret) {
    console.error('INTERNAL_FUNCTION_SECRET not found in .env');
    process.exit(1);
  }

  const res = await fetch(`${siteUrl}/.netlify/functions/deploy-site-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    body: JSON.stringify({ orderId }),
  });

  if (res.status !== 202) {
    console.error(`Unexpected response: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  console.log(`Deploy triggered for order ${orderId}.`);
  console.log(`Check the result in a bit at: ${siteUrl}/.netlify/functions/order-view?orderId=${orderId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
