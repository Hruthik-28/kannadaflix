'use strict';

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';

class TmdbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin TMDB v3 client.
 *  - Accepts either a v3 API key (32 hex chars) or a v4 read-access token (JWT, "eyJ...").
 *  - Limits concurrent requests.
 *  - Retries on 429 (honouring Retry-After), 5xx, timeouts and network errors.
 *  - Never retries 401/404 and other 4xx.
 */
class TmdbClient {
  constructor(cfg, opts = {}) {
    this.apiKey = cfg.apiKey;
    this.language = cfg.language;
    this.maxConcurrent = cfg.maxConcurrent || 8;
    this.timeoutMs = cfg.timeoutMs || 10000;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.retryBaseMs = cfg.retryBaseMs ?? 400;
    this.baseUrl = (opts.baseUrl || process.env.TMDB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.sleep = opts.sleep || sleepFor;
    this.active = 0;
    this.queue = [];
  }

  _acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  _release() {
    const next = this.queue.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else this.active -= 1;
  }

  _buildRequest(path, params) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = { Accept: 'application/json' };
    if (this.apiKey.startsWith('eyJ')) headers.Authorization = `Bearer ${this.apiKey}`;
    else url.searchParams.set('api_key', this.apiKey);
    return { url: url.toString(), headers };
  }

  async request(path, params = {}) {
    await this._acquire();
    try {
      return await this._requestWithRetry(path, params);
    } finally {
      this._release();
    }
  }

  async _requestWithRetry(path, params) {
    const { url, headers } = this._buildRequest(path, params);
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let waitMs = this.retryBaseMs * 2 ** attempt;
      try {
        const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return await res.json();

        if (res.status === 401) throw new TmdbError('TMDB rejected the API key (401). Check TMDB_API_KEY.', 401);
        if (res.status === 404) throw new TmdbError(`TMDB 404 for ${path}`, 404);
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
            waitMs = Math.min(retryAfter * 1000, 10000);
          }
          lastError = new TmdbError(`TMDB responded ${res.status} for ${path}`, res.status);
        } else {
          throw new TmdbError(`TMDB responded ${res.status} for ${path}`, res.status);
        }
      } catch (err) {
        if (err instanceof TmdbError && !(err.status === 429 || err.status >= 500)) throw err;
        lastError = err instanceof TmdbError ? err : new TmdbError(`TMDB request failed: ${err.message}`, 0);
      }
      if (attempt < this.maxRetries) await this.sleep(waitMs);
    }
    throw lastError;
  }

  discoverMovies(params, page) {
    return this.request('/discover/movie', {
      language: this.language,
      include_adult: 'false',
      include_video: 'false',
      ...params,
      page,
    });
  }

  searchMovies(query, page = 1) {
    return this.request('/search/movie', {
      query,
      language: this.language,
      include_adult: 'false',
      page,
    });
  }

  movieDetails(tmdbId, language = this.language) {
    return this.request(`/movie/${tmdbId}`, {
      language,
      append_to_response: 'credits,videos,external_ids',
    });
  }

  externalIds(tmdbId) {
    return this.request(`/movie/${tmdbId}/external_ids`);
  }

  findByImdb(imdbId) {
    return this.request(`/find/${imdbId}`, { external_source: 'imdb_id', language: this.language });
  }
}

module.exports = { TmdbClient, TmdbError };
