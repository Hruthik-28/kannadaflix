'use strict';

// Vercel adapter. Vercel runs a *function* per request instead of a long-lived server, so instead of
// serveHTTP() (which opens its own port) this builds the SDK's request router and calls it from a
// (req, res) handler. Local development keeps using index.js + serveHTTP().

const { getRouter } = require('stremio-addon-sdk');

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

/**
 * Vercel's CDN only caches function responses that carry `s-maxage`; the SDK emits plain `max-age`
 * (which only browsers/Stremio honour). Mirror max-age into s-maxage so repeated requests are answered
 * from Vercel's edge cache without waking a function or touching TMDB.
 */
function addEdgeCaching(res) {
  const end = res.end.bind(res);
  res.end = (...args) => {
    try {
      const cc = res.getHeader('Cache-Control');
      const m = typeof cc === 'string' && /(?:^|[\s,])max-age=(\d+)/.exec(cc);
      if (m && res.statusCode === 200 && !/s-maxage/.test(cc)) {
        res.setHeader('Cache-Control', `${cc}, s-maxage=${m[1]}`);
      }
    } catch (_) {
      /* headers already sent: leave as is */
    }
    return end(...args);
  };
}

function landingPage(manifest) {
  try {
    // Internal SDK helper (the same page serveHTTP shows at "/"). Optional: fall back to plain text.
    return require('stremio-addon-sdk/src/landingTemplate')(manifest);
  } catch (_) {
    return null;
  }
}

/**
 * Creates the (req, res) function for Vercel. Dependencies can be injected for testing.
 * The addon is built lazily on the first request and then reused by that function instance.
 */
function createHandler(options = {}) {
  let app = null;

  function build() {
    if (app) return app;
    const config = options.config || require('./config');
    if (!config.tmdb.apiKey) {
      // Not cached: fixing the variable and redeploying (or a new instance) is picked up immediately.
      console.error(
        '[kannadaflix] TMDB_API_KEY is not set. Add it in Vercel -> Project -> Settings -> Environment Variables, then redeploy.'
      );
      return null;
    }
    const { createAddon } = require('./addon');
    const { addonInterface } = createAddon({ config, tmdb: options.tmdb, idMap: options.idMap });
    app = {
      router: getRouter(addonInterface),
      landing: landingPage(addonInterface.manifest),
      manifest: addonInterface.manifest,
    };
    return app;
  }

  return function handler(req, res) {
    try {
      const built = build();
      if (!built) return json(res, 500, { err: 'addon is not configured: TMDB_API_KEY is missing' });

      // Accept both "/manifest.json" (rewrite keeps the original URL) and "/api/manifest.json".
      let url = req.url || '/';
      if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) url = url.slice(4) || '/';
      req.url = url;
      const pathname = url.split('?')[0];

      if (pathname === '/' || pathname === '') {
        if (built.landing) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(built.landing);
        }
        return json(res, 200, { name: built.manifest.name, manifest: '/manifest.json' });
      }

      addEdgeCaching(res);
      return built.router(req, res, () => json(res, 404, { err: 'not found' }));
    } catch (err) {
      console.error(`[kannadaflix] unhandled error: ${err && err.message}`);
      return json(res, 500, { err: 'internal error' });
    }
  };
}

module.exports = { createHandler, addEdgeCaching };
