'use strict';

const fs = require('fs');
const path = require('path');

const IMDB_RE = /^tt\d{5,}$/;
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check "no IMDb ID" after a week

const isImdbId = (value) => typeof value === 'string' && IMDB_RE.test(value);

/**
 * Maps TMDB ids <-> IMDb ids.
 *  - Positive mappings never change, so they are kept forever (and persisted to disk).
 *  - "No IMDb id yet" results are remembered for a week.
 *  - Lookups for the same id share one in-flight request.
 */
class IdMap {
  constructor(tmdb, { filePath = null, now = Date.now } = {}) {
    this.tmdb = tmdb;
    this.filePath = filePath;
    this.now = now;
    this.byTmdb = new Map(); // tmdbId(number) -> { imdb: 'tt..' | null, at }
    this.byImdb = new Map(); // 'tt..' -> tmdbId
    this.notKannada = new Map(); // imdb -> expiry ms (verified as a non-Kannada title)
    this.inflight = new Map();
    this.dirty = false;
    this.timer = null;
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [tmdbId, row] of Object.entries(data.entries || {})) {
        const id = Number(tmdbId);
        if (!Number.isInteger(id) || !row) continue;
        if (isImdbId(row.imdb)) this._remember(id, row.imdb, row.at || 0);
        else if (row.imdb === null) this.byTmdb.set(id, { imdb: null, at: row.at || 0 });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[idmap] ignoring unreadable ${this.filePath}: ${err.message}`);
    }
  }

  _remember(tmdbId, imdb, at = this.now()) {
    this.byTmdb.set(tmdbId, { imdb, at });
    if (imdb) this.byImdb.set(imdb, tmdbId);
    this._scheduleSave();
  }

  _scheduleSave() {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2000);
    this.timer.unref();
  }

  /** Writes the map to disk (atomic: temp file + rename). Safe to call any time. */
  flush() {
    if (!this.filePath || !this.dirty) return;
    try {
      const entries = {};
      for (const [id, row] of this.byTmdb) entries[id] = row;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.warn(`[idmap] could not save ${this.filePath}: ${err.message}`);
    }
  }

  /** Record a mapping learned elsewhere (e.g. from a details response). */
  learn(tmdbId, imdbId) {
    if (isImdbId(imdbId) && this.byTmdb.get(tmdbId)?.imdb !== imdbId) this._remember(tmdbId, imdbId);
  }

  /** TMDB id -> IMDb id, or null when TMDB has none. Throws on network/API errors. */
  async imdbFor(tmdbId) {
    const known = this.byTmdb.get(tmdbId);
    if (known) {
      if (known.imdb) return known.imdb;
      if (this.now() - known.at < NEGATIVE_TTL_MS) return null;
    }
    if (this.inflight.has(tmdbId)) return this.inflight.get(tmdbId);

    const promise = (async () => {
      try {
        const data = await this.tmdb.externalIds(tmdbId);
        const imdb = isImdbId(data.imdb_id) ? data.imdb_id : null;
        this._remember(tmdbId, imdb);
        return imdb;
      } catch (err) {
        if (err.status === 404) {
          this._remember(tmdbId, null);
          return null;
        }
        throw err;
      } finally {
        this.inflight.delete(tmdbId);
      }
    })();
    this.inflight.set(tmdbId, promise);
    return promise;
  }

  /** IMDb id -> TMDB id if we have seen it before, else undefined. */
  tmdbFor(imdbId) {
    return this.byImdb.get(imdbId);
  }

  markNotKannada(imdbId) {
    this.notKannada.set(imdbId, this.now() + 24 * 60 * 60 * 1000);
    if (this.notKannada.size > 5000) this.notKannada.delete(this.notKannada.keys().next().value);
  }

  isKnownNotKannada(imdbId) {
    const until = this.notKannada.get(imdbId);
    if (until === undefined) return false;
    if (until < this.now()) {
      this.notKannada.delete(imdbId);
      return false;
    }
    return true;
  }
}

module.exports = { IdMap, isImdbId };
