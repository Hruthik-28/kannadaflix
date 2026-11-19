'use strict';

const { toPreview, toFullMeta } = require('./meta');
const { isImdbId } = require('./idmap');
const { TtlCache } = require('./cache');

const KANNADA = 'kn';
const TMDB_PAGE_SIZE = 20; // TMDB returns 20 results per page
const MAX_PAGES_PER_REQUEST = 10; // safety cap when many results are dropped (e.g. no IMDb id)

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The four catalog definitions. Every one of them is restricted to
 * with_original_language=kn, so Indian-but-not-Kannada and dubbed titles never appear.
 */
function catalogDefinitions(cfg) {
  return {
    'kannadaflix-movies': () => ({
      sort_by: 'vote_count.desc', // best-known Kannada films first (different from "popular right now")
      with_original_language: KANNADA,
      'primary_release_date.lte': today(),
    }),
    'kannadaflix-latest': () => ({
      sort_by: 'primary_release_date.desc',
      with_original_language: KANNADA,
      'primary_release_date.lte': today(), // never list unreleased titles
    }),
    'kannadaflix-popular': () => ({
      sort_by: 'popularity.desc',
      with_original_language: KANNADA,
    }),
    'kannadaflix-toprated': () => ({
      sort_by: 'vote_average.desc',
      with_original_language: KANNADA,
      'vote_count.gte': cfg.catalog.minVotesTopRated, // hides 1-vote "10/10" entries
    }),
  };
}

/**
 * A lazily-loaded, de-duplicated, ordered list of previews for one catalog.
 *
 * Stremio's `skip` is "number of items already received", not a page number, and we drop
 * some TMDB rows (no IMDb id, duplicates). So instead of mapping skip -> TMDB page by
 * arithmetic, we build the *filtered* list incrementally and slice it: skip is always exact.
 */
class Feed {
  constructor({ tmdb, idMap, cfg, params }) {
    this.tmdb = tmdb;
    this.idMap = idMap;
    this.cfg = cfg;
    this.params = params;
    this.items = [];
    this.seen = new Set();
    this.nextPage = 1;
    this.exhausted = false;
    this.chain = Promise.resolve();
  }

  range(skip, limit) {
    const run = () => this._range(skip, limit);
    const p = this.chain.then(run, run); // serialise: concurrent requests never load a page twice
    this.chain = p.catch(() => {});
    return p;
  }

  async _range(skip, limit) {
    let loaded = 0;
    const started = Date.now();
    const budgetMs = this.cfg.catalog.requestBudgetMs;
    while (this.items.length < skip + limit && !this.exhausted && loaded < MAX_PAGES_PER_REQUEST) {
      // Bound the time of one request (important on serverless): once there is something new to return and
      // the budget is spent, answer with a shorter page. Stremio's next `skip` continues exactly from there.
      if (this.items.length > skip && Date.now() - started > budgetMs) break;
      try {
        await this._loadNextPage();
        loaded += 1;
      } catch (err) {
        if (this.items.length > skip) break; // return what we have rather than failing
        throw err;
      }
    }
    return this.items.slice(skip, skip + limit);
  }

  async _loadNextPage() {
    const page = this.nextPage;
    const data = await this.tmdb.discoverMovies(this.params, page);
    const results = Array.isArray(data.results) ? data.results : [];
    const metas = await resolvePreviews(results, this.idMap, this.cfg);
    // Only advance after everything succeeded, so a failure is retried instead of skipped.
    for (const meta of metas) {
      if (this.seen.has(meta.id)) continue;
      this.seen.add(meta.id);
      this.items.push(meta);
    }
    this.nextPage = page + 1;
    const lastPage = Math.min(data.total_pages || 0, this.cfg.catalog.maxDiscoverPages);
    if (results.length === 0 || page >= lastPage) this.exhausted = true;
  }
}

/** TMDB results -> Stremio previews with IMDb ids. Throws if an id lookup fails (not if the id is just missing). */
async function resolvePreviews(results, idMap, cfg) {
  const candidates = results.filter((m) => m && m.id && m.original_language === KANNADA);
  const settled = await Promise.allSettled(candidates.map((m) => idMap.imdbFor(m.id)));
  const failure = settled.find((s) => s.status === 'rejected');
  if (failure) throw failure.reason;

  const metas = [];
  candidates.forEach((m, i) => {
    const imdb = settled[i].value;
    if (isImdbId(imdb)) metas.push(toPreview(m, imdb, cfg));
    else if (cfg.catalog.includeWithoutImdb) metas.push(toPreview(m, `tmdb:${m.id}`, cfg));
  });
  return metas;
}

class CatalogService {
  constructor({ tmdb, idMap, cfg }) {
    this.tmdb = tmdb;
    this.idMap = idMap;
    this.cfg = cfg;
    this.definitions = catalogDefinitions(cfg);
    this.feeds = new Map(); // catalogId -> { feed, createdAt, prev }
    this.cache = new TtlCache({ maxEntries: 500 });
  }

  hasCatalog(id) {
    return Object.prototype.hasOwnProperty.call(this.definitions, id);
  }

  /** One page of a catalog. `skip` is Stremio's item offset. */
  async getCatalog(id, skip = 0) {
    const { pageSize } = this.cfg.catalog;
    const now = Date.now();
    let entry = this.feeds.get(id);
    if (!entry || now - entry.createdAt > this.cfg.cache.listTtlMs) {
      const feed = new Feed({ tmdb: this.tmdb, idMap: this.idMap, cfg: this.cfg, params: this.definitions[id]() });
      entry = { feed, createdAt: now, prev: entry ? entry.feed : null };
      this.feeds.set(id, entry);
    }
    try {
      const items = await entry.feed.range(skip, pageSize);
      if (items.length > 0 || skip === 0) entry.prev = null; // refresh worked; drop the stale copy
      return items;
    } catch (err) {
      if (entry.prev) return entry.prev.range(skip, pageSize); // stale-if-error
      throw err;
    }
  }

  /** Title search, Kannada movies only. */
  async search(query, skip = 0) {
    const q = String(query || '').trim().replace(/\s+/g, ' ');
    if (!q) return [];
    const key = `search:${q.toLowerCase()}`;
    const all = await this.cache.wrap(key, this.cfg.cache.searchTtlMs, () => this._search(q));
    return all.slice(skip, skip + this.cfg.catalog.pageSize);
  }

  async _search(q) {
    // TMDB's search can't filter by language, so scan a few relevance-ordered pages and keep only Kannada films.
    const first = await this.tmdb.searchMovies(q, 1);
    const totalPages = Math.min(first.total_pages || 1, this.cfg.catalog.maxSearchPages);
    const rest = [];
    for (let p = 2; p <= totalPages; p += 1) rest.push(this.tmdb.searchMovies(q, p).catch(() => ({ results: [] })));
    const pages = [first, ...(await Promise.all(rest))];

    const hits = [];
    const seenTmdb = new Set();
    for (const page of pages) {
      for (const m of page.results || []) {
        if (m.original_language !== KANNADA || seenTmdb.has(m.id)) continue;
        seenTmdb.add(m.id);
        hits.push(m);
      }
    }
    // Partial-match supplement: anything already loaded in our catalogs whose title contains the query.
    const needle = q.toLowerCase();
    for (const { feed } of this.feeds.values()) {
      for (const item of feed.items) {
        if (item.name.toLowerCase().includes(needle) && !hits.some((h) => h._id === item.id)) {
          hits.push({ _preview: item, _id: item.id });
        }
      }
    }

    const tmdbHits = hits.filter((h) => !h._preview);
    const metas = await resolvePreviews(tmdbHits, this.idMap, this.cfg);
    const out = [];
    const seen = new Set();
    for (const meta of [...metas, ...hits.filter((h) => h._preview).map((h) => h._preview)]) {
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      out.push(meta);
    }
    return out;
  }

  /**
   * Full metadata for an id ("tt..." or "tmdb:123"), or null when the title is not a Kannada film.
   */
  async getMeta(id) {
    return this.cache.wrap(`meta:${id}`, this.cfg.cache.detailTtlMs, () => this._getMeta(id));
  }

  async _getMeta(id) {
    let tmdbId;
    const tmdbMatch = /^tmdb:(\d+)$/.exec(id);
    if (tmdbMatch) {
      tmdbId = Number(tmdbMatch[1]);
    } else if (isImdbId(id)) {
      tmdbId = this.idMap.tmdbFor(id);
      if (!tmdbId) {
        if (this.idMap.isKnownNotKannada(id)) return null;
        // Not seen in our catalogs: Stremio may ask us about ANY imdb id, so verify it is Kannada first.
        const found = await this.tmdb.findByImdb(id);
        const movie = (found.movie_results || [])[0];
        if (!movie || movie.original_language !== KANNADA) {
          this.idMap.markNotKannada(id);
          return null;
        }
        tmdbId = movie.id;
        this.idMap.learn(tmdbId, id);
      }
    } else {
      return null;
    }

    let details;
    try {
      details = await this.tmdb.movieDetails(tmdbId);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    if (details.original_language !== KANNADA) return null;

    // TMDB returns an empty overview when there is no translation for the requested language;
    // fall back to the Kannada text so the page is not blank.
    if (!(details.overview || '').trim() && this.tmdb.language !== 'kn-IN') {
      try {
        const kn = await this.tmdb.movieDetails(tmdbId, 'kn-IN');
        if ((kn.overview || '').trim()) details.overview = kn.overview;
      } catch (_) {
        /* optional fallback: ignore */
      }
    }

    const imdb = details.imdb_id || (details.external_ids && details.external_ids.imdb_id);
    if (isImdbId(imdb)) this.idMap.learn(tmdbId, imdb);
    const outId = isImdbId(imdb) ? imdb : `tmdb:${tmdbId}`;
    // If the caller used an id that doesn't match the canonical one, keep what they asked for.
    return toFullMeta(details, id === outId ? outId : id, this.cfg);
  }
}

module.exports = { CatalogService, catalogDefinitions, TMDB_PAGE_SIZE };
