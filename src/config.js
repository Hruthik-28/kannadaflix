'use strict';

// Loads settings from environment variables (and from a local .env file if present).
// Secrets are never hardcoded: TMDB_API_KEY must come from the environment.
require('dotenv').config({ quiet: true });

const path = require('path');

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim());

let apiKey = (process.env.TMDB_API_KEY || '').trim();
if (apiKey === 'your_tmdb_api_key_here') apiKey = '';

const idMapRaw = process.env.ID_MAP_PATH;
const idMapPath =
  idMapRaw && idMapRaw.toLowerCase() === 'off'
    ? null
    : path.resolve(idMapRaw || path.join(__dirname, '..', 'data', 'id-map.json'));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

module.exports = {
  port: int(process.env.PORT, 7000),
  idMapPath,
  tmdb: {
    apiKey,
    language: process.env.TMDB_LANGUAGE || 'en-US',
    maxConcurrent: 8,
    timeoutMs: 10000,
    maxRetries: int(process.env.TMDB_MAX_RETRIES, 3),
    retryBaseMs: int(process.env.TMDB_RETRY_BASE_MS, 400),
  },
  catalog: {
    pageSize: int(process.env.PAGE_SIZE, 40),
    minVotesTopRated: int(process.env.MIN_VOTES_TOP_RATED, 20),
    includeWithoutImdb: bool(process.env.INCLUDE_WITHOUT_IMDB, false),
    ratingAsImdb: bool(process.env.SHOW_TMDB_RATING_AS_IMDB_RATING, false),
    maxSearchPages: 8, // TMDB search is not language-filtered, so we scan a few pages
    maxDiscoverPages: 500, // TMDB hard limit
  },
  cache: {
    listTtlMs: int(process.env.CACHE_TTL_MINUTES, 30) * MINUTE,
    searchTtlMs: 10 * MINUTE,
    detailTtlMs: 24 * HOUR,
    metaMaxAgeSec: 6 * 60 * 60,
    catalogMaxAgeSec: int(process.env.CACHE_TTL_MINUTES, 30) * 60,
    searchMaxAgeSec: 10 * 60,
    errorMaxAgeSec: 30,
  },
};
