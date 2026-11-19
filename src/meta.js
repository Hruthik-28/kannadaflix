'use strict';

// Converts TMDB movie objects into Stremio meta objects.
// Nothing is invented: when TMDB has no value for a field, the field is simply left out.

const IMG = 'https://image.tmdb.org/t/p';

// TMDB's movie genre ids are stable; a static map avoids an extra API call per start-up.
const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western',
};

const clean = (obj) => {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete obj[key];
  }
  return obj;
};

const posterUrl = (p) => (p ? `${IMG}/w500${p}` : undefined);
const backgroundUrl = (p) => (p ? `${IMG}/w1280${p}` : undefined);

const isoDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? `${d}T00:00:00.000Z` : undefined);
const yearOf = (d) => (/^\d{4}/.test(d || '') ? d.slice(0, 4) : undefined);

function ratingLine(m) {
  if (!(m.vote_average > 0) || !(m.vote_count > 0)) return undefined;
  return `⭐ TMDB ${m.vote_average.toFixed(1)}/10 (${m.vote_count.toLocaleString('en-US')} votes)`;
}

function description(m, cfg, extraLines = []) {
  const lines = [];
  if (!cfg.catalog.ratingAsImdb) lines.push(ratingLine(m));
  const original = (m.original_title || '').trim();
  const title = (m.title || '').trim();
  if (original && original !== title) lines.push(`Original title: ${original}`);
  lines.push(...extraLines);
  lines.push((m.overview || '').trim());
  return lines.filter(Boolean).join('\n\n') || undefined;
}

function imdbRating(m, cfg) {
  return cfg.catalog.ratingAsImdb && m.vote_average > 0 && m.vote_count > 0 ? m.vote_average.toFixed(1) : undefined;
}

/** Light object used inside catalog responses. `id` is an IMDb id (or "tmdb:<id>" when allowed). */
function toPreview(m, id, cfg) {
  const genres = (m.genre_ids || []).map((g) => GENRES[g]).filter(Boolean);
  return clean({
    id,
    type: 'movie',
    name: (m.title || m.original_title || '').trim() || 'Untitled',
    poster: posterUrl(m.poster_path),
    posterShape: 'poster',
    background: backgroundUrl(m.backdrop_path),
    releaseInfo: yearOf(m.release_date),
    released: isoDate(m.release_date),
    imdbRating: imdbRating(m, cfg),
    genres,
    description: description(m, cfg),
  });
}

/** Full object for the meta handler, built from /movie/{id}?append_to_response=credits,videos,external_ids. */
function toFullMeta(m, id, cfg) {
  const crew = (m.credits && m.credits.crew) || [];
  const cast = ((m.credits && m.credits.cast) || []).slice(0, 12).map((p) => p.name).filter(Boolean);
  const directors = crew.filter((p) => p.job === 'Director').map((p) => p.name).filter(Boolean);
  const writers = crew
    .filter((p) => ['Writer', 'Screenplay', 'Story'].includes(p.job))
    .map((p) => p.name)
    .filter(Boolean);
  const trailers = ((m.videos && m.videos.results) || [])
    .filter((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.key)
    .slice(0, 3)
    .map((v) => ({ source: v.key, type: 'Trailer' }));
  const countries = (m.production_countries || []).map((c) => c.name).filter(Boolean);

  return clean({
    id,
    type: 'movie',
    name: (m.title || m.original_title || '').trim() || 'Untitled',
    poster: posterUrl(m.poster_path),
    posterShape: 'poster',
    background: backgroundUrl(m.backdrop_path),
    releaseInfo: yearOf(m.release_date),
    released: isoDate(m.release_date),
    runtime: m.runtime > 0 ? `${m.runtime} min` : undefined,
    imdbRating: imdbRating(m, cfg),
    genres: (m.genres || []).map((g) => g.name).filter(Boolean),
    description: description(m, cfg, m.tagline ? [`"${m.tagline.trim()}"`] : []),
    director: [...new Set(directors)],
    writer: [...new Set(writers)],
    cast,
    country: countries.join(', '),
    language: 'Kannada',
    trailers,
    imdb_id: /^tt\d+$/.test(id) ? id : undefined,
  });
}

module.exports = { toPreview, toFullMeta, posterUrl, GENRES };
