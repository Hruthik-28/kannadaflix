# KannadaFlix – Stremio addon for Kannada movies

A lightweight, catalog-only Stremio addon. It lists **Kannada-language** movies (TMDB `original_language = kn`)
with posters, descriptions, years, ratings and search.
It does **not** provide streams – keep using Torrentio / AIOStreams for that. Because every movie is
identified by its **IMDb id (`tt…`)**, those addons find streams for KannadaFlix movies automatically.

## Catalogs

| Catalog | What it shows | TMDB sort |
|---|---|---|
| **Kannada Movies** (also the search catalog) | Released Kannada films, best-known first | most votes |
| **Latest Kannada Releases** | Released Kannada films, newest first (never unreleased) | release date ↓ |
| **Popular Kannada Movies** | Currently popular Kannada films | popularity ↓ |
| **Top Rated Kannada Movies** | Highest-rated Kannada films with at least `MIN_VOTES_TOP_RATED` votes (default 20) | rating ↓ |

Only the first catalog accepts search (otherwise Stremio would show the same results four times).

## Quick start on Windows 11 (PowerShell)

Requires [Node.js 18 or newer](https://nodejs.org) (`node -v` to check).

```powershell
# 1. Go to the project folder and install dependencies
cd path\to\kannadaflix
npm install

# 2. Create your config file and add your TMDB key
Copy-Item .env.example .env
notepad .env          # set TMDB_API_KEY=...  then save

# 3. Start the server
npm start
```

Get a free TMDB key at <https://www.themoviedb.org/settings/api> (the "API Key" or the
"API Read Access Token" both work). The key lives only in `.env` (git-ignored) or in an environment variable.

You should see:

```
KannadaFlix is running. Manifest: http://127.0.0.1:7000/manifest.json
TMDB connection OK.
```

> Prefer not to use a `.env` file? `$env:TMDB_API_KEY = "your_key"; npm start`

### 4. Install in Stremio

Either:

- In Stremio desktop open **Addons**, paste `http://127.0.0.1:7000/manifest.json` into the
  addon-URL box and click **Install**; or
- Start with `npm start -- --install` (opens Stremio's install dialog), or open
  `stremio://127.0.0.1:7000/manifest.json`.

The four catalogs then appear on the **Board** and under **Discover → Movies**; searching in Stremio
includes the "Kannada Movies" results. Your laptop has to be running the server while you use it.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TMDB_API_KEY` | – (required) | TMDB v3 key or v4 read token |
| `PORT` | `7000` | Local port (hosts usually set this for you) |
| `TMDB_LANGUAGE` | `en-US` | Language for titles/overviews |
| `PAGE_SIZE` | `40` | Movies per Stremio page |
| `MIN_VOTES_TOP_RATED` | `20` | Vote floor for Top Rated |
| `CACHE_TTL_MINUTES` | `30` | Catalog cache lifetime |
| `INCLUDE_WITHOUT_IMDB` | `false` | List movies TMDB has no IMDb id for (as `tmdb:<id>`; streams addons will not find these) |
| `SHOW_TMDB_RATING_AS_IMDB_RATING` | `false` | Put the TMDB score in Stremio's rating badge (which carries an IMDb logo). Off by default so a TMDB score is not passed off as IMDb's; the score is shown at the top of the description instead |
| `ID_MAP_PATH` | `./data/id-map.json` | Disk cache of TMDB→IMDb ids (`off` disables) |

## How it works

```
index.js            starts the HTTP server (stremio-addon-sdk serveHTTP), checks the TMDB key
src/config.js       reads environment variables / .env
src/addon.js        manifest + catalog handler + meta handler (no stream handler)
src/catalog.js      the 4 catalog queries, pagination, search, meta lookup
src/meta.js         TMDB movie -> Stremio meta object (poster, year, genres, cast, trailers …)
src/tmdb.js         TMDB client: auth, concurrency limit, timeouts, retry on 429/5xx
src/idmap.js        TMDB id <-> IMDb id mapping, persisted to data/id-map.json
src/cache.js        TTL cache with request de-duplication and stale-if-error
test/               automated tests against a mock TMDB (run with `npm test`)
```

Design notes:

- **IDs.** TMDB's discover endpoint does not return IMDb ids, so each movie's IMDb id is looked up once and
  remembered (in memory and on disk) – the first load of a catalog is slower, later ones are instant.
  Movies with no IMDb id are left out by default.
- **Pagination.** Stremio's `skip` is "how many items I already have". The addon builds the filtered,
  de-duplicated list incrementally and slices it, so pages never overlap or leave gaps even when some TMDB
  rows are dropped.
- **Kannada only.** Queries use `with_original_language=kn`, and every result is re-checked, so Hindi/Tamil/etc.
  films and Kannada *dubs* never appear.
- **Search.** Uses TMDB title search (English transliterations, original Kannada-script titles and alternative
  titles), keeps only Kannada films, and also matches titles already loaded in the catalogs by substring.
- **Meta handler.** Answers only for Kannada titles; for any other id it returns 404 so Cinemeta and other
  addons handle it as usual.
- **Resilience.** Timeouts, retries with back-off (honours `Retry-After`), stale data served if TMDB is down,
  and an empty-with-30s-cache reply instead of an error if nothing is available.

## Deploying (HTTPS)

Stremio requires **HTTPS** for addons that are not on `localhost`. Any host that can run a Node web service works
(Render, Railway, Fly.io, Koyeb, a VPS behind Caddy/nginx…). Vercel/Netlify style serverless hosting is not a good
fit for this server.

1. Push this folder to a GitHub repository (`.env` and `data/` are git-ignored).
2. Create a new **Web Service** from the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the environment variable `TMDB_API_KEY` in the host's dashboard (never commit it).
4. Deploy, then open `https://<your-app>/manifest.json` to check it, and install that URL in Stremio.

Notes: free tiers may sleep when idle (first request is slow); the id cache lives on disk, so on hosts with an
ephemeral filesystem it is simply rebuilt after a restart (or set `ID_MAP_PATH=off`).

## Testing checklist (in Stremio)

- [ ] Addons page shows **KannadaFlix** with 4 catalogs.
- [ ] **Kannada Movies** shows posters; scroll down and more load (no repeats).
- [ ] **Latest Kannada Releases** – newest release first; nothing in the future.
- [ ] **Popular Kannada Movies** and **Top Rated Kannada Movies** load; Top Rated has no 1-vote "10/10" films.
- [ ] Everything listed is Kannada (no Hindi/Tamil/Telugu or dubbed titles).
- [ ] Open a movie: details/cast/trailer show, and Torrentio / AIOStreams list streams.
- [ ] Search a partial title (e.g. `kant`) and a Kannada-script title (e.g. `ಕಾಂತಾರ`); only Kannada films appear.
- [ ] Search for gibberish: empty result, no error.

Automated tests: `npm test` (19 tests, mock TMDB, no network needed).
