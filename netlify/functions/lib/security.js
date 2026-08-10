const { getStore } = require('@netlify/blobs');

function getClientIp(event) {
  const headers = event.headers || {};
  const forwarded = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

// Best-effort throttle, not a strict guarantee: relies on a get-then-set against
// Netlify Blobs, so a tight burst of concurrent requests can slip past the limit.
// Good enough to blunt casual scripted spam without adding an external service.
async function checkRateLimit(key, { limit, windowMs }) {
  const store = getStore('ratelimits');
  const now = Date.now();
  const existing = await store.get(key, { type: 'json' });

  let windowStart = now;
  let count = 1;
  if (existing && now - existing.windowStart < windowMs) {
    windowStart = existing.windowStart;
    count = existing.count + 1;
  }

  await store.setJSON(key, { windowStart, count });
  return count <= limit;
}

// Browsers send Origin on cross-site fetches; same-site/simple requests and
// non-browser clients may omit it, so an absent header is allowed through and
// relies on rate limiting instead. `allowedHostSuffixes` lets a caller permit
// any host ending in e.g. ".netlify.app" (every deployed customer site lives
// on its own subdomain there).
function isAllowedOrigin(event, allowedHostSuffixes = []) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).host;
  } catch (err) {
    return false;
  }

  const requestHost = headers.host || headers['x-forwarded-host'];
  if (host === requestHost) return true;
  return allowedHostSuffixes.some((suffix) => host.endsWith(suffix));
}

module.exports = { getClientIp, checkRateLimit, isAllowedOrigin };
