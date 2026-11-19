'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const defaultConfig = require('./config');
const { TmdbClient } = require('./tmdb');
const { IdMap } = require('./idmap');
const { CatalogService } = require('./catalog');

const SEARCH_CATALOG = 'kannadaflix-movies';

const manifest = {
  id: 'community.kannadaflix',
  version: '1.0.0',
  name: 'KannadaFlix',
  description: 'Discover Kannada-language movies: catalogs, posters, ratings and search. Metadata only - streams come from your other addons.',
  resources: [
    'catalog',
    // Meta is only answered for Kannada titles; for any other id the addon replies 404 so Cinemeta etc. take over.
    { name: 'meta', types: ['movie'], idPrefixes: ['tt', 'tmdb:'] },
  ],
  types: ['movie'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: [
    // Only this catalog supports search, otherwise Stremio would show the same results four times.
    { type: 'movie', id: 'kannadaflix-movies', name: 'Kannada Movies', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'kannadaflix-latest', name: 'Latest Kannada Releases', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'kannadaflix-popular', name: 'Popular Kannada Movies', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'kannadaflix-toprated', name: 'Top Rated Kannada Movies', extra: [{ name: 'skip', isRequired: false }] },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
};

const parseSkip = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Builds the addon interface. Dependencies can be injected (used by the tests);
 * in normal use everything comes from the environment.
 */
function createAddon(options = {}) {
  const cfg = options.config || defaultConfig;
  const tmdb = options.tmdb || new TmdbClient(cfg.tmdb);
  const idMap = options.idMap || new IdMap(tmdb, { filePath: cfg.idMapPath, seedPath: cfg.idMapSeedPath });
  const service = new CatalogService({ tmdb, idMap, cfg });
  const { cache } = cfg;

  const builder = new addonBuilder({ ...manifest });

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'movie' || !service.hasCatalog(id)) return { metas: [], cacheMaxAge: cache.errorMaxAgeSec };
    const skip = parseSkip(extra && extra.skip);
    try {
      const search = extra && typeof extra.search === 'string' ? extra.search : undefined;
      if (search !== undefined) {
        if (id !== SEARCH_CATALOG) return { metas: [] };
        const metas = await service.search(search, skip);
        return { metas, cacheMaxAge: cache.searchMaxAgeSec };
      }
      const metas = await service.getCatalog(id, skip);
      return { metas, cacheMaxAge: cache.catalogMaxAgeSec, staleError: 24 * 60 * 60 };
    } catch (err) {
      console.error(`[catalog ${id}] ${err.message}`);
      // Empty + short cache: Stremio will simply retry soon instead of remembering a failure.
      return { metas: [], cacheMaxAge: cache.errorMaxAgeSec };
    }
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'movie') return Promise.reject({ message: 'unsupported type', noHandler: true });
    let meta;
    try {
      meta = await service.getMeta(id);
    } catch (err) {
      console.error(`[meta ${id}] ${err.message}`);
      return Promise.reject({ message: 'temporarily unavailable', noHandler: true });
    }
    // Not a Kannada title -> 404, so Stremio falls through to other metadata addons.
    if (!meta) return Promise.reject({ message: 'not a Kannada title', noHandler: true });
    return { meta, cacheMaxAge: cache.metaMaxAgeSec };
  });

  return { addonInterface: builder.getInterface(), service, idMap, tmdb };
}

module.exports = { createAddon, manifest };
