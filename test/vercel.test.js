'use strict';

process.env.TMDB_API_KEY = 'test-key-SECRET-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const baseConfig = require('../src/config');
const { createHandler } = require('../src/vercel');
const { TmdbClient } = require('../src/tmdb');
const { IdMap } = require('../src/idmap');
const { startMockTmdb } = require('./mock-tmdb');

const ROOT = path.join(__dirname, '..');
const IMDB = /^tt\d+$/;

function makeConfig(overrides = {}) {
  return {
    ...baseConfig,
    idMapPath: null,
    idMapSeedPath: null,
    tmdb: { ...baseConfig.tmdb, retryBaseMs: 1, ...(overrides.tmdb || {}) },
    catalog: { ...baseConfig.catalog, ...(overrides.catalog || {}) },
    cache: { ...baseConfig.cache, ...(overrides.cache || {}) },
  };
}

// Mounts the Vercel handler in a plain http server: the same (req, res) contract Vercel uses.
async function boot(mock, overrides = {}, handlerOpts = {}) {
  const config = makeConfig(overrides);
  const tmdb = new TmdbClient(config.tmdb, { baseUrl: mock.baseUrl });
  const handler = createHandler({ config, tmdb, ...handlerOpts });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body, text };
  };
  return { get, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

test('api/index.js loads without a key and exports a (req, res) function', () => {
  const out = execFileSync(process.execPath, ['-e', "const h=require('./api/index.js'); console.log(typeof h, h.length)"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH }, // no TMDB_API_KEY
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'function 2');
});

test('vercel.json rewrites every path to the function and sets a duration', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.deepEqual(cfg.rewrites, [{ source: '/(.*)', destination: '/api' }]);
  assert.ok(cfg.functions['api/index.js'].maxDuration >= 10);
  assert.ok(fs.existsSync(path.join(ROOT, 'api', 'index.js')));
});

test('/manifest.json: valid, four catalogs, CORS, no stream resource, no secrets', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const r = await app.get('/manifest.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.body.name, 'KannadaFlix');
  assert.deepEqual(r.body.catalogs.map((c) => c.id), ['kannadaflix-movies', 'kannadaflix-latest', 'kannadaflix-popular', 'kannadaflix-toprated']);
  assert.ok(!JSON.stringify(r.body.resources).includes('stream'));
  assert.ok(!r.text.includes('SECRET'));
  await app.close(); await mock.close();
});

test('all four catalog routes return Kannada-only movies with IMDb ids', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  for (const id of ['movies', 'latest', 'popular', 'toprated']) {
    const r = await app.get(`/catalog/movie/kannadaflix-${id}.json`);
    assert.equal(r.status, 200, id);
    assert.ok(r.body.metas.length > 0, id);
    for (const m of r.body.metas) {
      assert.match(m.id, IMDB);
      assert.ok(!/Tamil|Hindi/.test(m.name));
    }
    assert.ok(!r.text.includes('SECRET'), 'API key never appears in responses');
  }
  await app.close(); await mock.close();
});

test('pagination via skip is exact through the Vercel handler', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const got = [];
  let skip = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await app.get(skip ? `/catalog/movie/kannadaflix-popular/skip=${skip}.json` : '/catalog/movie/kannadaflix-popular.json');
    if (!r.body.metas.length) break;
    got.push(...r.body.metas.map((m) => m.id));
    skip += r.body.metas.length;
  }
  const expected = mock.data.kn.filter((m) => m.imdb).map((m) => m.imdb);
  assert.equal(new Set(got).size, got.length);
  assert.deepEqual([...got].sort(), [...expected].sort());
  await app.close(); await mock.close();
});

test('a tiny time budget gives shorter pages but pagination stays exact', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock, { catalog: { requestBudgetMs: 0 } });
  const got = [];
  let skip = 0;
  let sizes = [];
  for (let i = 0; i < 20; i += 1) {
    const r = await app.get(skip ? `/catalog/movie/kannadaflix-popular/skip=${skip}.json` : '/catalog/movie/kannadaflix-popular.json');
    if (!r.body.metas.length) break;
    sizes.push(r.body.metas.length);
    got.push(...r.body.metas.map((m) => m.id));
    skip += r.body.metas.length;
  }
  const expected = mock.data.kn.filter((m) => m.imdb).map((m) => m.imdb);
  assert.ok(Math.max(...sizes) < 40, 'pages were cut short by the budget');
  assert.equal(new Set(got).size, got.length);
  assert.deepEqual([...got].sort(), [...expected].sort());
  await app.close(); await mock.close();
});

test('search works, including Kannada script and percent-encoded queries', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let r = await app.get('/catalog/movie/kannadaflix-movies/search=kantara.json');
  assert.deepEqual(r.body.metas.map((m) => m.id), ['tt9100001']);
  r = await app.get('/catalog/movie/kannadaflix-movies/search=' + encodeURIComponent('ಕಾಂತಾರ') + '.json');
  assert.deepEqual(r.body.metas.map((m) => m.id), ['tt9100001']);
  r = await app.get('/catalog/movie/kannadaflix-movies/search=Kannada%20Fil.json');
  assert.ok(r.body.metas.length > 0);
  assert.ok(!r.body.metas.some((m) => m.id === 'tt9200000'));
  r = await app.get('/catalog/movie/kannadaflix-movies/search=%20.json');
  assert.deepEqual(r.body.metas, []);
  await app.close(); await mock.close();
});

test('meta: valid Kannada id works; non-Kannada, unknown and wrong-type ids are 404 JSON', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let r = await app.get('/meta/movie/tt9100001.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.id, 'tt9100001');
  assert.equal(r.body.meta.language, 'Kannada');
  for (const p of ['/meta/movie/tt9200000.json', '/meta/movie/tt1234567.json', '/meta/series/tt9100001.json', '/meta/movie/garbage.json']) {
    r = await app.get(p);
    assert.equal(r.status, 404, p);
  }
  await app.close(); await mock.close();
});

test('incomplete TMDB data (no poster / date / overview) is handled', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const all = [];
  for (const skip of [0, 40, 80]) all.push(...(await app.get(`/catalog/movie/kannadaflix-popular/skip=${skip}.json`)).body.metas);
  assert.ok(all.find((m) => m.id === 'tt9000003' && !('poster' in m)));
  assert.ok(all.find((m) => m.id === 'tt9000005' && !('releaseInfo' in m)));
  const meta = await app.get('/meta/movie/tt9000007.json'); // empty English overview
  assert.equal(meta.status, 200);
  assert.match(meta.body.meta.description, /ಕನ್ನಡ ಸಾರಾಂಶ/);
  await app.close(); await mock.close();
});

test('missing TMDB_API_KEY: clear JSON 500 + server log, no crash, no exit', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const config = makeConfig({ tmdb: { apiKey: '' } });
    const server = http.createServer(createHandler({ config }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of ['/manifest.json', '/catalog/movie/kannadaflix-popular.json', '/']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 500, p);
      assert.match((await res.json()).err, /TMDB_API_KEY/);
    }
    assert.ok(errors.some((e) => /TMDB_API_KEY is not set/.test(e)), 'useful log line');
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  } finally {
    console.error = orig;
  }
});

test('TMDB failures and a rejected key degrade gracefully and never leak the key', async () => {
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    let mock = await startMockTmdb();
    mock.state.failMode = 'always';
    let app = await boot(mock, { tmdb: { maxRetries: 1 } });
    let r = await app.get('/catalog/movie/kannadaflix-popular.json');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.metas, []);
    assert.match(r.headers.get('cache-control'), /max-age=30/);
    assert.equal((await app.get('/meta/movie/tt9100001.json')).status, 404);
    await app.close(); await mock.close();

    mock = await startMockTmdb();
    mock.state.failMode = 'unauthorized';
    app = await boot(mock);
    r = await app.get('/catalog/movie/kannadaflix-popular.json');
    assert.deepEqual(r.body.metas, []);
    assert.ok(logs.some((l) => /401|API key/.test(l)), 'invalid key is logged');
    await app.close(); await mock.close();
  } finally {
    console.error = origErr;
  }
  assert.ok(!logs.join('\n').includes('SECRET'), 'key never appears in logs');
});

test('timeouts: a hanging TMDB does not hang the addon', async () => {
  const hang = http.createServer(() => { /* never answers */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const mock = { baseUrl: `http://127.0.0.1:${hang.address().port}` };
  const errors = console.error; console.error = () => {};
  const app = await boot(mock, { tmdb: { timeoutMs: 100, maxRetries: 0 } });
  const t0 = Date.now();
  const r = await app.get('/catalog/movie/kannadaflix-popular.json');
  console.error = errors;
  assert.deepEqual(r.body.metas, []);
  assert.ok(Date.now() - t0 < 3000);
  await app.close();
  await new Promise((r) => { hang.close(r); hang.closeAllConnections?.(); });
});

test('Vercel CDN caching: s-maxage mirrors max-age on successful responses only', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let r = await app.get('/catalog/movie/kannadaflix-popular.json');
  assert.match(r.headers.get('cache-control'), /max-age=1800/);
  assert.match(r.headers.get('cache-control'), /s-maxage=1800/);
  r = await app.get('/meta/movie/tt9100001.json');
  assert.match(r.headers.get('cache-control'), /s-maxage=21600/);
  r = await app.get('/meta/movie/tt9200000.json'); // 404 must not be cached by the CDN
  assert.ok(!/s-maxage/.test(r.headers.get('cache-control') || ''));
  await app.close(); await mock.close();
});

test('routing: "/" landing page, unknown paths 404, "/api/..." prefix tolerated', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  let r = await app.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  r = await app.get('/nope');
  assert.equal(r.status, 404);
  r = await app.get('/api/manifest.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'KannadaFlix');
  await app.close(); await mock.close();
});

test('concurrent identical requests share work (in-flight de-duplication)', async () => {
  const mock = await startMockTmdb();
  const app = await boot(mock);
  const results = await Promise.all(Array.from({ length: 8 }, () => app.get('/catalog/movie/kannadaflix-popular.json')));
  assert.ok(results.every((r) => r.status === 200 && r.body.metas.length === results[0].body.metas.length));
  const pages = mock.state.discoverPages;
  assert.ok(pages.length >= 1);
  assert.equal(new Set(pages).size, pages.length, `no TMDB page fetched twice: ${pages}`);
  for (const m of mock.data.kn) {
    assert.ok((mock.state.hits[`/movie/${m.id}/external_ids`] || 0) <= 1, `external id of ${m.id} fetched at most once`);
  }
  await app.close(); await mock.close();
});

test('a cold start (fresh handler instance) works on its own', async () => {
  const mock = await startMockTmdb();
  const a = await boot(mock);
  const b = await boot(mock); // a second, independent instance with empty caches
  const ra = await a.get('/catalog/movie/kannadaflix-latest.json');
  const rb = await b.get('/catalog/movie/kannadaflix-latest.json');
  assert.deepEqual(ra.body.metas.map((m) => m.id), rb.body.metas.map((m) => m.id));
  await a.close(); await b.close(); await mock.close();
});

// ---- id cache without writable persistent storage ----

test('config: on Vercel the id cache is memory-only; locally it still uses data/id-map.json', () => {
  const read = (env) => JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify({p:c.idMapPath,s:c.idMapSeedPath,v:c.onVercel,t:c.tmdb.timeoutMs}))"], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  const vercel = read({ VERCEL: '1' });
  assert.equal(vercel.p, null);
  assert.equal(vercel.v, true);
  assert.equal(vercel.t, 8000);
  assert.ok(vercel.s.endsWith(path.join('seed', 'id-map.seed.json')));
  const local = read({});
  assert.ok(local.p.endsWith(path.join('data', 'id-map.json')));
  assert.equal(local.v, false);
});

test('IdMap with an unwritable cache path: no throw, mappings stay in memory, no repeat lookups', async () => {
  const mock = await startMockTmdb();
  const tmdb = new TmdbClient({ ...baseConfig.tmdb, apiKey: 'k', retryBaseMs: 1 }, { baseUrl: mock.baseUrl });
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-ro-')), 'file');
  fs.writeFileSync(blocker, 'x'); // a *file* where a directory would be needed -> mkdir/write must fail
  const warn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a.join(' '));
  const map = new IdMap(tmdb, { filePath: path.join(blocker, 'sub', 'id-map.json') });
  assert.equal(await map.imdbFor(1001), 'tt9000001');
  assert.doesNotThrow(() => map.flush());
  console.warn = warn;
  assert.ok(warnings.some((w) => /could not save/.test(w)), 'failure is reported, not thrown');
  assert.equal(await map.imdbFor(1001), 'tt9000001');
  assert.equal(mock.state.hits['/movie/1001/external_ids'], 1, 'second lookup served from memory');
  assert.equal(map.tmdbFor('tt9000001'), 1001);
  await mock.close();
});

test('IdMap without any file path never creates timers or files', async () => {
  const mock = await startMockTmdb();
  const tmdb = new TmdbClient({ ...baseConfig.tmdb, apiKey: 'k' }, { baseUrl: mock.baseUrl });
  const map = new IdMap(tmdb, { filePath: null });
  await map.imdbFor(1002);
  assert.equal(map.timer, null);
  assert.equal(map.dirty, false);
  await mock.close();
});

test('read-only seed file: mappings load with zero TMDB lookups, and loading does not write anything', async () => {
  const mock = await startMockTmdb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-seed-'));
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ version: 1, entries: { 1001: { imdb: 'tt9000001', at: 1 }, 1002: { imdb: 'tt9000002', at: 1 } } }));
  fs.chmodSync(seed, 0o444);
  const tmdb = new TmdbClient({ ...baseConfig.tmdb, apiKey: 'k' }, { baseUrl: mock.baseUrl });
  const map = new IdMap(tmdb, { seedPath: seed });
  assert.equal(await map.imdbFor(1001), 'tt9000001');
  assert.equal(await map.imdbFor(1002), 'tt9000002');
  assert.equal(map.tmdbFor('tt9000002'), 1002);
  assert.equal(map.dirty, false);
  assert.equal(Object.keys(mock.state.hits).filter((k) => k.includes('external_ids')).length, 0);
  // a corrupt seed is ignored, not fatal
  fs.chmodSync(seed, 0o644); fs.writeFileSync(seed, '{not json');
  const w = console.warn; console.warn = () => {};
  const bad = new IdMap(tmdb, { seedPath: seed });
  console.warn = w;
  assert.equal(await bad.imdbFor(1003), 'tt9000003');
  // a missing seed is silent
  assert.doesNotThrow(() => new IdMap(tmdb, { seedPath: path.join(dir, 'nope.json') }));
  await mock.close();
});

test('loading an existing local cache file does not rewrite it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-load-'));
  const file = path.join(dir, 'id-map.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { 1001: { imdb: 'tt9000001', at: 1 } } }));
  const before = fs.statSync(file).mtimeMs;
  const map = new IdMap(null, { filePath: file });
  assert.equal(map.dirty, false);
  assert.equal(map.timer, null);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('export-id-map script keeps only positive mappings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-export-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'export-id-map.js'), path.join(dir, 'scripts', 'export-id-map.js'));
  fs.writeFileSync(path.join(dir, 'data', 'id-map.json'), JSON.stringify({ version: 1, entries: { 1: { imdb: 'tt1234567', at: 5 }, 2: { imdb: null, at: 5 } } }));
  execFileSync(process.execPath, [path.join(dir, 'scripts', 'export-id-map.js')], { cwd: dir });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'seed', 'id-map.seed.json'), 'utf8'));
  assert.deepEqual(Object.keys(out.entries), ['1']);
});
