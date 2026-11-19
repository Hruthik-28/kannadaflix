'use strict';

// Copies the positive TMDB->IMDb mappings from the local cache (data/id-map.json, filled while you run
// `npm start`) into seed/id-map.seed.json, which is committed and shipped read-only with a Vercel deployment.
// This only saves lookups on cold starts; the addon works without it.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'data', 'id-map.json');
const dest = path.join(__dirname, '..', 'seed', 'id-map.seed.json');

let data;
try {
  data = JSON.parse(fs.readFileSync(src, 'utf8'));
} catch (err) {
  console.error(`Could not read ${src}: ${err.message}\nRun "npm start" and open the catalogs in Stremio first so it gets filled.`);
  process.exit(1);
}

const entries = {};
for (const [tmdbId, row] of Object.entries(data.entries || {})) {
  if (row && /^tt\d{5,}$/.test(row.imdb)) entries[tmdbId] = { imdb: row.imdb, at: row.at || 0 }; // positives only
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify({ version: 1, entries }));
console.log(`Wrote ${Object.keys(entries).length} mappings to ${path.relative(process.cwd(), dest)}`);
