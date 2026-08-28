const { getBlobStore } = require('./blobs');

function getClientIp(event) {
  const headers = event.headers || {};
  const forwarded = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

// Best-effort throttle, not a strict guarantee: relies on a get-then-set against
// Netlify Blobs, so a tight burst of concurrent requests can slip past the limit.
// Good enough to blunt casual scripted spam without adding an external service.
async function checkRateLimit(key, { limit, windowMs }) {
  const store = getBlobStore('ratelimits');
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

// `host === domain` for an exact match, or `host` is a subdomain of `domain` -
// anchored on a dot boundary so "netlify.app" matches "foo.netlify.app" but
// never "evilnetlify.app" (a bare string-suffix check would let that through).
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function originHost(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch (err) {
    return undefined; // present but unparseable - distinct from "absent"
  }
}

// Browsers send Origin on cross-site fetches; same-site/simple requests and
// non-browser clients may omit it, so an absent header is allowed through and
// relies on rate limiting instead. `allowedDomains` lets a caller permit a
// specific domain (and its subdomains) beyond the request's own host - e.g.
// "netlify.app" (every deployed customer site lives on its own subdomain
// there) or a storefront's own domain once it's hosted separately (see
// STOREFRONT_ORIGIN in order.js).
function isAllowedOrigin(event, allowedDomains = []) {
  const host = originHost(event);
  if (host === null) return true;
  if (host === undefined) return false;

  const headers = event.headers || {};
  const requestHost = headers.host || headers['x-forwarded-host'];
  if (host === requestHost) return true;
  return allowedDomains.some((domain) => hostMatches(host, domain));
}

// isAllowedOrigin above only decides whether *this server* accepts the
// request - it does nothing to make the *browser* hand the response back to
// the calling page's JS. That needs these headers on every response (the
// actual one AND the OPTIONS preflight browsers send first for any POST with
// a JSON body), reflecting back the same origin isAllowedOrigin just okayed.
function getCorsHeaders(event, allowedDomains = []) {
  const host = originHost(event);
  if (!host) return {};

  const headers = event.headers || {};
  const requestHost = headers.host || headers['x-forwarded-host'];
  if (host === requestHost) return {};
  if (!allowedDomains.some((domain) => hostMatches(host, domain))) return {};

  return {
    'Access-Control-Allow-Origin': headers.origin || headers.Origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Shared with order.js (validating submitted config before storing it) and
// order-view.js (defense-in-depth when rendering that stored config back out
// as HTML for the manager) - only data: uploads and https: links are ever
// legitimate for these fields, so anything else (javascript:, etc.) is rejected.
function isSafeImageUrl(url) {
  return typeof url === 'string' && /^(data:image\/|https:\/\/)/i.test(url);
}

function isSafeAudioUrl(url) {
  return typeof url === 'string' && /^(data:audio\/|https:\/\/)/i.test(url);
}

function isSafeHttpsUrl(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url);
}

module.exports = {
  getClientIp,
  checkRateLimit,
  isAllowedOrigin,
  getCorsHeaders,
  isSafeImageUrl,
  isSafeAudioUrl,
  isSafeHttpsUrl,
};
