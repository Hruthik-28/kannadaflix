'use strict';

// A tiny fake TMDB used by the tests. It mimics only the endpoints the addon calls.
const http = require('http');

function buildDataset() {
  const movies = [];
  const base = new Date('2026-11-01T00:00:00Z');
  for (let i = 0; i < 55; i += 1) {
    const id = 1000 + i;
    const date = new Date(base.getTime() - i * 40 * 86400000).toISOString().slice(0, 10);
    movies.push({
      id,
      title: `Kannada Film ${i}`,
      original_title: i % 2 === 0 ? `ಕನ್ನಡ ಚಿತ್ರ ${i}` : `Kannada Film ${i}`,
      original_language: 'kn',
      overview: i === 7 ? '' : `Overview for film ${i}`,
      poster_path: i === 3 ? null : `/poster${i}.jpg`,
      backdrop_path: `/back${i}.jpg`,
      release_date: i === 5 ? '' : date,
      vote_average: 5 + ((i * 7) % 40) / 10,
      vote_count: i % 9 === 0 ? 3 : 50 + i * 3,
      popularity: 100 - ((i * 13) % 97) + i / 100,
      genre_ids: [18, 28],
      imdb: i % 11 === 10 ? null : `tt${String(9000000 + i)}`, // every 11th has no IMDb id
    });
  }
  // one future-dated film (must not appear in Latest)
  movies.push({ id: 1500, title: 'Kannada Upcoming', original_title: 'Kannada Upcoming', original_language: 'kn', overview: 'Not out yet', poster_path: '/up.jpg', backdrop_path: null, release_date: '2099-01-01', vote_average: 0, vote_count: 0, popularity: 50, genre_ids: [], imdb: 'tt9100000' });
  // a Kannada film with a Kannada-script title only
  movies.push({ id: 1501, title: 'Kantara Legend', original_title: 'ಕಾಂತಾರ', original_language: 'kn', overview: 'Folklore', poster_path: '/k.jpg', backdrop_path: '/kb.jpg', release_date: '2022-09-30', vote_average: 8.1, vote_count: 5000, popularity: 300, genre_ids: [28], imdb: 'tt9100001' });
  // non-Kannada films
  const others = [
    { id: 2000, title: 'Kannada Dubbed Tamil Film', original_title: 'Tamil Film', original_language: 'ta', overview: 'Dubbed', poster_path: '/t.jpg', backdrop_path: null, release_date: '2024-01-01', vote_average: 9.9, vote_count: 9999, popularity: 9999, genre_ids: [], imdb: 'tt9200000' },
    { id: 2001, title: 'Kannada Hindi Film', original_title: 'Hindi Film', original_language: 'hi', overview: 'Hindi', poster_path: '/h.jpg', backdrop_path: null, release_date: '2024-01-01', vote_average: 9.9, vote_count: 9999, popularity: 9999, genre_ids: [], imdb: 'tt9200001' },
  ];
  return { kn: movies, others };
}

function startMockTmdb() {
  const data = buildDataset();
  const all = [...data.kn, ...data.others];
  const state = { discoverPages: [], hits: {}, failMode: null, failures: 0, leak: true, detailCalls: 0 };

  const byId = new Map(all.map((m) => [m.id, m]));
  const strip = ({ imdb, ...rest }) => rest;
  const paginate = (list, page) => ({
    page,
    results: list.slice((page - 1) * 20, page * 20).map(strip),
    total_pages: Math.max(1, Math.ceil(list.length / 20)),
    total_results: list.length,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    state.hits[route] = (state.hits[route] || 0) + 1;
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (state.failMode === 'always') return json(500, { status_message: 'boom' });
    if (state.failMode === 'rate-limit-once' && state.failures < 1) {
      state.failures += 1;
      return json(429, { status_message: 'slow down' }, { 'Retry-After': '0' });
    }
    if (state.failMode === 'unauthorized') return json(401, { status_message: 'Invalid API key' });

    const q = url.searchParams;
    const page = parseInt(q.get('page') || '1', 10);

    if (route === '/discover/movie') {
      state.discoverPages.push(`${q.get('sort_by')}#${page}`);
      let list = (q.get('with_original_language') ? all.filter((m) => m.original_language === q.get('with_original_language')) : all).slice();
      const lte = q.get('primary_release_date.lte');
      if (lte) list = list.filter((m) => m.release_date && m.release_date <= lte);
      const minVotes = q.get('vote_count.gte');
      if (minVotes) list = list.filter((m) => m.vote_count >= Number(minVotes));
      const sort = q.get('sort_by');
      const key = { 'vote_count.desc': ['vote_count', -1], 'popularity.desc': ['popularity', -1], 'vote_average.desc': ['vote_average', -1], 'primary_release_date.desc': ['release_date', -1] }[sort] || ['popularity', -1];
      list.sort((a, b) => (a[key[0]] < b[key[0]] ? 1 : a[key[0]] > b[key[0]] ? -1 : 0)); // all sorts used are descending
      // Simulate TMDB's occasional shifting results: page 2 repeats the last item of page 1.
      const out = paginate(list, page);
      if (page === 2 && list.length > 20) out.results.unshift(strip(list[19]));
      // Simulate a non-Kannada leak on page 1 (the addon must still drop it).
      if (state.leak && page === 1 && q.get('with_original_language') === 'kn') out.results.push(strip(data.others[0]));
      return json(200, out);
    }

    if (route === '/search/movie') {
      const needle = (q.get('query') || '').toLowerCase();
      const hits = all.filter((m) => `${m.title} ${m.original_title}`.toLowerCase().includes(needle));
      return json(200, paginate(hits, page));
    }

    let m = /^\/movie\/(\d+)\/external_ids$/.exec(route);
    if (m) {
      const movie = byId.get(Number(m[1]));
      if (!movie) return json(404, { status_message: 'not found' });
      return json(200, { id: movie.id, imdb_id: movie.imdb || null });
    }

    m = /^\/movie\/(\d+)$/.exec(route);
    if (m) {
      state.detailCalls += 1;
      const movie = byId.get(Number(m[1]));
      if (!movie) return json(404, { status_message: 'not found' });
      const lang = q.get('language');
      const overview = lang === 'kn-IN' && !movie.overview ? 'ಕನ್ನಡ ಸಾರಾಂಶ' : movie.overview;
      return json(200, {
        ...strip(movie),
        overview,
        imdb_id: movie.imdb || null,
        runtime: 140,
        tagline: 'A tagline',
        genres: [{ id: 18, name: 'Drama' }],
        production_countries: [{ iso_3166_1: 'IN', name: 'India' }],
        credits: { cast: [{ name: 'Actor One' }, { name: 'Actor Two' }], crew: [{ name: 'Director One', job: 'Director' }] },
        videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc123' }, { site: 'Vimeo', type: 'Trailer', key: 'zzz' }] },
        external_ids: { imdb_id: movie.imdb || null },
      });
    }

    m = /^\/find\/(tt\d+)$/.exec(route);
    if (m) {
      const movie = all.find((x) => x.imdb === m[1]);
      return json(200, { movie_results: movie ? [strip(movie)] : [] });
    }

    return json(404, { status_message: 'unknown route' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, data, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

module.exports = { startMockTmdb };
