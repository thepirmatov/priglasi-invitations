const { getStore } = require('@netlify/blobs');

// getStore()'s automatic (zero-config) mode depends on Netlify's Functions
// runtime injecting NETLIFY_BLOBS_CONTEXT at invocation time - this has been
// observed to fail intermittently in production even when the call site
// follows every documented rule (inside the handler, not at module load) -
// see https://answers.netlify.com/t/missingblobsenvironmenterror-on-fresh-sites/164777.
// SITE_ID is a Netlify-guaranteed runtime env var (unlike NETLIFY_BLOBS_CONTEXT),
// and NETLIFY_AUTH_TOKEN is already required setup (see README) for
// deploy-site-background.js's own Netlify API calls - passing both explicitly
// sidesteps the automatic-context dependency entirely instead of hoping it works.
function getBlobStore(name) {
  return getStore({ name, siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
}

module.exports = { getBlobStore };
