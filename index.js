'use strict';

const { serveHTTP } = require('stremio-addon-sdk');
const config = require('./src/config');

if (!config.tmdb.apiKey) {
  console.error(
    '\nTMDB_API_KEY is not set.\n' +
      '  1. Get a free key: https://www.themoviedb.org/settings/api\n' +
      '  2. Copy .env.example to .env and put the key in it (or set the TMDB_API_KEY environment variable).\n'
  );
  process.exit(1);
}

const { createAddon } = require('./src/addon');
const { addonInterface, idMap, tmdb } = createAddon();

serveHTTP(addonInterface, { port: config.port })
  .then(({ url }) => {
    console.log(`KannadaFlix is running. Manifest: ${url}`);
    console.log(`Install in Stremio: stremio://${url.replace(/^https?:\/\//, '')}`);
    // Friendly start-up check so a wrong key is obvious immediately (does not block start-up).
    tmdb
      .request('/configuration')
      .then(() => console.log('TMDB connection OK.'))
      .catch((err) => {
        if (err.status === 401) console.error('\n!! TMDB rejected your API key. Fix TMDB_API_KEY in .env and restart.\n');
        else console.warn(`Could not reach TMDB right now (${err.message}). Catalogs will retry automatically.`);
      });
  })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set a different PORT in .env.`);
    else console.error(err);
    process.exit(1);
  });

// Save the TMDB->IMDb id cache on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    idMap.flush();
    process.exit(0);
  });
}
