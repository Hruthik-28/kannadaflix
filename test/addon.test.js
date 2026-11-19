'use strict';

process.env.TMDB_API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveHTTP } = require('stremio-addon-sdk');
const baseConfig = require('../src/config');
const { createAddon } = require('../src/addon');
const { TmdbClient } = require('../src/tmdb');
const { IdMap } = require('../src/idmap');
const { startMockTmdb } = require('./mock-tmdb');

const IMDB = /^tt\d+$/;

async function boot(mock, overrides = {}) {
  const config = {
    ...baseConfig,
    idMapPath: null,
    tmdb: { ...baseConfig.tmdb, apiKey: 'test-key', retryBaseMs: 1, ...(overrides.tmdb || {}) },
    catalog: { ...baseConfig.catalog, ...(overrides.catalog || {}) },
    cache: { ...baseConfig.cache, ...(overrides.cache || {}) },
  };
  const tmdb = new TmdbClient(config.tmdb, { baseUrl: mock.baseUrl });
  const { addonInterface, service } = createAddon({ config, tmdb });
  const { url, server } = await serveHTTP(addonInterface, { port: 0 });
  const base = url.replace('/manifest.json', '');
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  };
  return { get, service, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

const expectedKannadaWithImdb = (mock) =>
  mock.data.kn.filter((m) => m.imdb && m.original_language === 'kn');

test('manifest has exactly four catalogs; only the first supports search', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const { body, status } = await app.get('/manifest.json');
  assert.equal(status, 200);
  assert.equal(body.name, 'KannadaFlix');
  assert.deepEqual(body.catalogs.map((c) => c.name), ['Kannada Movies', 'Latest Kannada Releases', 'Popular Kannada Movies', 'Top Rated Kannada Movies']);
  assert.ok(body.catalogs.every((c) => c.type === 'movie'));
  assert.deepEqual(body.catalogs.filter((c) => c.extra.some((e) => e.name === 'search')).map((c) => c.id), ['kannadaflix-movies']);
  assert.ok(!body.resources.includes('stream'), 'no stream resource');
  await app.close(); await mock.close();
});

test('every catalog returns Kannada-only movies with IMDb ids, valid metas and no duplicates', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  for (const id of ['kannadaflix-movies', 'kannadaflix-latest', 'kannadaflix-popular', 'kannadaflix-toprated']) {
    const { status, body } = await app.get(`/catalog/movie/${id}.json`);
    assert.equal(status, 200, id);
    assert.ok(body.metas.length > 0, `${id} is not empty`);
    const ids = body.metas.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${id} has no duplicates`);
    for (const m of body.metas) {
      assert.match(m.id, IMDB, 'IMDb id used');
      assert.equal(m.type, 'movie');
      assert.ok(m.name && !/Tamil|Hindi/.test(m.name), 'no dubbed/other-language films');
    }
  }
  await app.close(); await mock.close();
});

test('pagination with skip is exact: no overlap, no gaps, ends cleanly', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const collected = [];
  let skip = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const path = skip ? `/catalog/movie/kannadaflix-popular/skip=${skip}.json` : '/catalog/movie/kannadaflix-popular.json';
    const { body } = await app.get(path);
    if (body.metas.length === 0) break;
    assert.ok(body.metas.length <= 40);
    collected.push(...body.metas.map((m) => m.id));
    skip += body.metas.length; // Stremio sets skip to the number of items received
  }
  const expected = expectedKannadaWithImdb(mock).map((m) => m.imdb);
  assert.equal(new Set(collected).size, collected.length, 'no duplicates across pages');
  assert.deepEqual([...collected].sort(), [...expected].sort(), 'every Kannada film with an IMDb id appears exactly once');
  await app.close(); await mock.close();
});

test('pagination works with a skip that is not a multiple of the page size', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const full = (await app.get('/catalog/movie/kannadaflix-popular.json')).body.metas;
  const second = (await app.get('/catalog/movie/kannadaflix-popular/skip=17.json')).body.metas;
  assert.equal(second[0].id, full[17].id);
  await app.close(); await mock.close();
});

test('Popular follows TMDB popularity order', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const { body } = await app.get('/catalog/movie/kannadaflix-popular.json');
  const byImdb = new Map(mock.data.kn.map((m) => [m.imdb, m]));
  const pops = body.metas.map((m) => byImdb.get(m.id).popularity);
  assert.deepEqual(pops, [...pops].sort((a, b) => b - a));
  await app.close(); await mock.close();
});

test('Latest is newest-first and never lists unreleased films', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const { body } = await app.get('/catalog/movie/kannadaflix-latest.json');
  const dates = body.metas.map((m) => m.released).filter(Boolean);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.ok(!body.metas.some((m) => m.id === 'tt9100000'), 'future film excluded');
  await app.close(); await mock.close();
});

test('Top Rated is sorted by rating and enforces the minimum vote count', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock, { catalog: { minVotesTopRated: 20 } });
  const { body } = await app.get('/catalog/movie/kannadaflix-toprated.json');
  const byImdb = new Map(mock.data.kn.map((m) => [m.imdb, m]));
  const rows = body.metas.map((m) => byImdb.get(m.id));
  assert.ok(rows.every((r) => r.vote_count >= 20), 'low-vote films excluded');
  const ratings = rows.map((r) => r.vote_average);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));
  await app.close(); await mock.close();
});

test('non-Kannada results leaking from TMDB are dropped', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const { body } = await app.get('/catalog/movie/kannadaflix-popular.json');
  assert.ok(!body.metas.some((m) => m.id === 'tt9200000' || m.id === 'tt9200001'));
  await app.close(); await mock.close();
});

test('missing poster / overview / release date are handled without fabricating data', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let all = [];
  for (const skip of [0, 40, 80]) all = all.concat((await app.get(`/catalog/movie/kannadaflix-popular/skip=${skip}.json`)).body.metas);
  const noPoster = all.find((m) => m.id === 'tt9000003');
  assert.ok(noPoster && !('poster' in noPoster), 'poster field omitted, item still listed');
  const noDate = all.find((m) => m.id === 'tt9000005');
  assert.ok(noDate && !('releaseInfo' in noDate) && !('released' in noDate));
  for (const m of all) for (const v of Object.values(m)) assert.notEqual(v, null);
  await app.close(); await mock.close();
});

test('movies without an IMDb id are skipped by default and kept as tmdb:<id> when enabled', async () => {
  const mock = await startMockTmdb();
  let app = await boot(mock);
  let all = [];
  for (const skip of [0, 40, 80]) all = all.concat((await app.get(`/catalog/movie/kannadaflix-popular/skip=${skip}.json`)).body.metas);
  assert.ok(all.every((m) => IMDB.test(m.id)));
  await app.close();

  app = await boot(mock, { catalog: { includeWithoutImdb: true } });
  all = [];
  for (const skip of [0, 40, 80, 120]) all = all.concat((await app.get(`/catalog/movie/kannadaflix-popular/skip=${skip}.json`)).body.metas);
  assert.ok(all.some((m) => m.id.startsWith('tmdb:')));
  const tmdbItem = all.find((m) => m.id.startsWith('tmdb:'));
  const meta = await app.get(`/meta/movie/${encodeURIComponent(tmdbItem.id)}.json`);
  assert.equal(meta.status, 200);
  await app.close(); await mock.close();
});

test('search: partial title, Kannada script, Kannada-only, empty query, wrong catalog', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);

  let r = await app.get('/catalog/movie/kannadaflix-movies/search=Kannada%20Fil.json');
  assert.ok(r.body.metas.length > 0);
  assert.ok(!r.body.metas.some((m) => m.id === 'tt9200000' || m.id === 'tt9200001'), 'dubbed/other-language films excluded');

  r = await app.get('/catalog/movie/kannadaflix-movies/search=kantara.json');
  assert.deepEqual(r.body.metas.map((m) => m.id), ['tt9100001']);

  r = await app.get('/catalog/movie/kannadaflix-movies/search=' + encodeURIComponent('ಕಾಂತಾರ') + '.json');
  assert.deepEqual(r.body.metas.map((m) => m.id), ['tt9100001']);

  r = await app.get('/catalog/movie/kannadaflix-movies/search=%20%20.json');
  assert.deepEqual(r.body.metas, []);

  r = await app.get('/catalog/movie/kannadaflix-movies/search=zzzzzz.json');
  assert.deepEqual(r.body.metas, []);

  r = await app.get('/catalog/movie/kannadaflix-latest/search=kantara.json');
  assert.deepEqual(r.body.metas, []);

  // search results paginate through skip too
  const s1 = (await app.get('/catalog/movie/kannadaflix-movies/search=Kannada%20Film.json')).body.metas;
  const s2 = (await app.get(`/catalog/movie/kannadaflix-movies/search=Kannada%20Film&skip=${s1.length}.json`)).body.metas;
  assert.equal(new Set([...s1, ...s2].map((m) => m.id)).size, s1.length + s2.length);
  await app.close(); await mock.close();
});

test('meta: full object for a Kannada IMDb id, 404 for non-Kannada and unknown ids', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);

  let r = await app.get('/meta/movie/tt9100001.json');
  assert.equal(r.status, 200);
  const m = r.body.meta;
  assert.equal(m.id, 'tt9100001');
  assert.equal(m.name, 'Kantara Legend');
  assert.equal(m.runtime, '140 min');
  assert.equal(m.releaseInfo, '2022');
  assert.deepEqual(m.director, ['Director One']);
  assert.deepEqual(m.trailers, [{ source: 'abc123', type: 'Trailer' }]);
  assert.match(m.description, /Original title: ಕಾಂತಾರ/);
  assert.match(m.poster, /^https:\/\/image\.tmdb\.org\/t\/p\/w500\//);

  // Kannada overview fallback when English overview is empty (film index 7)
  r = await app.get('/meta/movie/tt9000007.json');
  assert.match(r.body.meta.description, /ಕನ್ನಡ ಸಾರಾಂಶ/);

  r = await app.get('/meta/movie/tt9200000.json'); // Tamil film
  assert.equal(r.status, 404);
  r = await app.get('/meta/movie/tt1234567.json'); // unknown
  assert.equal(r.status, 404);
  r = await app.get('/meta/series/tt9100001.json');
  assert.equal(r.status, 404);
  await app.close(); await mock.close();
});

test('TMDB rating is not passed off as an IMDb rating unless explicitly enabled', async () => {
  const mock = await startMockTmdb();
  let app = await boot(mock);
  let m = (await app.get('/meta/movie/tt9100001.json')).body.meta;
  assert.equal(m.imdbRating, undefined);
  assert.match(m.description, /TMDB 8\.1\/10/);
  await app.close();
  app = await boot(mock, { catalog: { ratingAsImdb: true } });
  m = (await app.get('/meta/movie/tt9100001.json')).body.meta;
  assert.equal(m.imdbRating, '8.1');
  await app.close(); await mock.close();
});

test('responses are cached: repeated requests do not hit TMDB again', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  await app.get('/catalog/movie/kannadaflix-popular.json');
  const before = JSON.stringify(mock.state.hits);
  const r = await app.get('/catalog/movie/kannadaflix-popular.json');
  assert.equal(JSON.stringify(mock.state.hits), before);
  assert.match(r.headers.get('cache-control'), /max-age=\d+/);
  await app.get('/meta/movie/tt9100001.json');
  const detailBefore = mock.state.detailCalls;
  await app.get('/meta/movie/tt9100001.json');
  assert.equal(mock.state.detailCalls, detailBefore);
  await app.close(); await mock.close();
});

test('rate limits are retried; hard failures degrade to an empty list with a short cache', async () => {
  let mock = await startMockTmdb();
  mock.state.failMode = 'rate-limit-once';
  let app = await boot(mock);
  let r = await app.get('/catalog/movie/kannadaflix-popular.json');
  assert.equal(r.status, 200);
  assert.ok(r.body.metas.length > 0, 'recovered after a 429');
  await app.close(); await mock.close();

  mock = await startMockTmdb();
  mock.state.failMode = 'always';
  app = await boot(mock, { tmdb: { maxRetries: 1 } });
  r = await app.get('/catalog/movie/kannadaflix-popular.json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.metas, []);
  assert.match(r.headers.get('cache-control'), /max-age=30/);
  r = await app.get('/catalog/movie/kannadaflix-movies/search=kantara.json');
  assert.deepEqual(r.body.metas, []);
  r = await app.get('/meta/movie/tt9100001.json');
  assert.equal(r.status, 404);
  await app.close(); await mock.close();
});

test('a failure after a good load serves the stale catalog instead of nothing', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock, { tmdb: { maxRetries: 0 }, cache: { listTtlMs: 1 } });
  const good = (await app.get('/catalog/movie/kannadaflix-popular.json')).body.metas;
  assert.ok(good.length > 0);
  await new Promise((r) => setTimeout(r, 10)); // let the feed expire
  mock.state.failMode = 'always';
  const again = (await app.get('/catalog/movie/kannadaflix-popular.json')).body.metas;
  assert.deepEqual(again.map((m) => m.id), good.map((m) => m.id));
  await app.close(); await mock.close();
});

test('unknown catalog ids and types return empty lists, not errors', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let r = await app.get('/catalog/movie/nope.json');
  assert.deepEqual(r.body.metas, []);
  r = await app.get('/catalog/series/kannadaflix-popular.json');
  assert.deepEqual(r.body.metas, []);
  await app.close(); await mock.close();
});

test('TMDB->IMDb id map persists to disk and reloads', async () => {
  const mock = await startMockTmdb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-')), 'id-map.json');
  const tmdb = new TmdbClient({ ...baseConfig.tmdb, apiKey: 'k', retryBaseMs: 1 }, { baseUrl: mock.baseUrl });
  const a = new IdMap(tmdb, { filePath: file });
  assert.equal(await a.imdbFor(1001), 'tt9000001');
  assert.equal(await a.imdbFor(1010), null); // no IMDb id on TMDB
  a.flush();
  const calls = mock.state.hits['/movie/1001/external_ids'];
  const b = new IdMap(tmdb, { filePath: file });
  assert.equal(await b.imdbFor(1001), 'tt9000001');
  assert.equal(b.tmdbFor('tt9000001'), 1001);
  assert.equal(mock.state.hits['/movie/1001/external_ids'], calls, 'served from disk, no new request');
  await mock.close();
});

test('v4 read-access tokens are sent as a Bearer header, v3 keys as api_key', async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => { seen.push({ url, headers: opts.headers }); return { ok: true, json: async () => ({}) }; };
  await new TmdbClient({ ...baseConfig.tmdb, apiKey: 'eyJabc.def.ghi' }, { fetchImpl: fakeFetch }).request('/x');
  await new TmdbClient({ ...baseConfig.tmdb, apiKey: 'a'.repeat(32) }, { fetchImpl: fakeFetch }).request('/x');
  assert.equal(seen[0].headers.Authorization, 'Bearer eyJabc.def.ghi');
  assert.ok(!seen[0].url.includes('api_key'));
  assert.ok(seen[1].url.includes('api_key=' + 'a'.repeat(32)));
  assert.equal(seen[1].headers.Authorization, undefined);
});
