#!/usr/bin/env node
// Renders each template with its config.example.json in a real mobile-emulated
// viewport (via puppeteer-core driving the local Chrome install) and saves a
// portrait PNG for the storefront carousel. Uses CDP device-metrics emulation
// rather than the plain `chrome --screenshot` CLI, which does not reliably
// honor the responsive <meta viewport> tag and clips wide desktop-layout output.

const puppeteer = require('puppeteer-core');
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'public');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const SCREENSHOTS_DIR = path.join(ROOT, 'catalog', 'screenshots');
const CATALOG_PATH = path.join(ROOT, 'catalog', 'templates.json');
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
};

function findChrome() {
  const found = CHROME_PATHS.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium install found in known paths.');
  return found;
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, urlPath);
    if (existsSync(filePath) && require('fs').statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const port = 8934;
  const server = await startServer(port);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });

  try {
    for (const entry of catalog.templates) {
      const templateDir = path.join(TEMPLATES_DIR, entry.id);
      copyFileSync(path.join(templateDir, 'config.example.json'), path.join(templateDir, 'config.json'));

      const outPath = path.join(ROOT, 'catalog', entry.screenshot);
      console.log(`Rendering ${entry.id} -> ${entry.screenshot}`);

      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.goto(`http://localhost:${port}/templates/${entry.id}/`, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.screenshot({ path: outPath });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
