'use strict';

/**
 * Small in-memory TTL cache with:
 *  - in-flight request de-duplication (concurrent callers share one fetch)
 *  - stale-if-error (an expired value is served if the refresh fails)
 *  - a size cap (oldest entries are evicted first)
 */
class TtlCache {
  constructor({ maxEntries = 2000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.store = new Map(); // key -> { value, expires }
    this.inflight = new Map(); // key -> Promise
  }

  get(key) {
    const entry = this.store.get(key);
    return entry && entry.expires > this.now() ? entry.value : undefined;
  }

  set(key, value, ttlMs) {
    this.store.delete(key); // refresh insertion order
    this.store.set(key, { value, expires: this.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      this.store.delete(this.store.keys().next().value);
    }
  }

  async wrap(key, ttlMs, loader) {
    const fresh = this.get(key);
    if (fresh !== undefined) return fresh;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const stale = this.store.get(key);
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } catch (err) {
        if (stale) return stale.value; // serve stale rather than failing
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  clear() {
    this.store.clear();
  }
}

module.exports = { TtlCache };
