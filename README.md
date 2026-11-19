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

There are two ways to run it, with the same code:

- **[Local development](#local-development-on-windows-11)** – `npm start` on your own computer.
- **[Vercel deployment](#vercel-deployment)** – a permanent HTTPS manifest URL that works in Stremio Web and on other devices.

## Local development on Windows 11

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

### 4. Install in Stremio (local)

Either:

- In Stremio desktop open **Addons**, paste `http://127.0.0.1:7000/manifest.json` into the
  addon-URL box and click **Install**; or
- Start with `npm start -- --install` (opens Stremio's install dialog), or open
  `stremio://127.0.0.1:7000/manifest.json`.

The four catalogs then appear on the **Board** and under **Discover → Movies**; searching in Stremio
includes the "Kannada Movies" results. Your laptop has to be running the server while you use it, and
`http://127.0.0.1` only works for Stremio apps on that same computer (use the Vercel deployment for Stremio Web and other devices).

### 5. Run the tests

```powershell
npm test
```

41 automated tests run against a mock TMDB server (no internet or API key needed).

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
| `ID_MAP_PATH` | `./data/id-map.json` locally, none on Vercel | Disk cache of TMDB→IMDb ids (`off` disables) |
| `ID_MAP_SEED_PATH` | `./seed/id-map.seed.json` | Optional read-only starting data for the id cache (see below) |
| `REQUEST_BUDGET_MS` | `8000` | Once a catalog request has something to return, it stops loading more TMDB pages after this long |
| `TMDB_TIMEOUT_MS` | `10000` (`8000` on Vercel) | Timeout for each TMDB request |
| `TMDB_MAX_RETRIES` | `3` (`2` on Vercel) | Retries on 429 / 5xx / network errors |

## How it works

```
index.js            LOCAL entry point: starts the HTTP server (serveHTTP), checks the TMDB key
api/index.js        VERCEL entry point (serverless function) – thin wrapper around src/vercel.js
src/vercel.js       Vercel adapter: builds the SDK router, calls it per request, adds CDN caching headers
vercel.json         sends every URL to the function; sets max duration and ships seed/
scripts/export-id-map.js   copies learned id mappings into seed/ (optional, see below)
src/config.js       reads environment variables / .env
src/addon.js        manifest + catalog handler + meta handler (no stream handler)
src/catalog.js      the 4 catalog queries, pagination, search, meta lookup
src/meta.js         TMDB movie -> Stremio meta object (poster, year, genres, cast, trailers …)
src/tmdb.js         TMDB client: auth, concurrency limit, timeouts, retry on 429/5xx
src/idmap.js        TMDB id <-> IMDb id mapping, persisted to data/id-map.json
src/cache.js        TTL cache with request de-duplication and stale-if-error
test/               automated tests against a mock TMDB (run with `npm test`)
seed/               optional read-only id cache that ships with a Vercel deployment
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

## Vercel deployment

### How it differs from local

Vercel does not run a long-lived server: each request is handled by a short-lived serverless function.
So on Vercel the addon is served from `api/index.js` (not `index.js`), and:

- **No writable disk.** The TMDB→IMDb id cache is kept in memory per function instance. Nothing is written to disk, there are no timers, and nothing depends on a shutdown event.
- **Cold starts.** A fresh instance starts with empty caches, so its first catalog request has to look up IMDb ids again (about 20 small TMDB calls per page, a second or two). To avoid most of that, see *Optional: ship a seed* below.
- **CDN caching.** Responses carry `s-maxage`, so Vercel's edge cache answers repeated requests (30 min for catalogs, 10 min for search, 6 h for movie details) without running the function or calling TMDB.
- **Time limits.** The function is allowed 30 s (`vercel.json`), and a single catalog request stops loading extra TMDB pages after `REQUEST_BUDGET_MS` (8 s). If it stops early it returns a slightly shorter page and Stremio's next request continues exactly where it left off – nothing is skipped or repeated.

### Step by step

1. **Push to GitHub** (see the Git commands below).
2. Go to <https://vercel.com/new> and **import** your GitHub repository (authorise Vercel for the repo if asked).
3. **Configure the project** on the import screen:
   - Framework Preset: **Other**
   - Root Directory: leave as `./`
   - Build Command, Output Directory, Install Command: leave empty / default
   - Node.js version: `package.json` asks for 22.x (Settings → General → Node.js Version should show 22.x).
4. Open **Environment Variables** and add:
   - `TMDB_API_KEY` = your TMDB key (apply to **Production**, and Preview if you use previews).
   - Optional: any other variable from the table above.
5. Click **Deploy**.
6. When it finishes, open **Project → Settings → Domains** and note your production domain, e.g. `kannadaflix.vercel.app`.
7. **Test in a browser** (replace with your domain):
   - `https://YOUR-PROJECT.vercel.app/manifest.json` → JSON with `"name":"KannadaFlix"` and four catalogs
   - `https://YOUR-PROJECT.vercel.app/catalog/movie/kannadaflix-popular.json` → JSON with a `metas` list (the first request after a deploy can take a few seconds)
   - `https://YOUR-PROJECT.vercel.app/meta/movie/tt1234567.json` → use any `id` copied from the catalog output (should return a `meta` object)
8. **Install in Stremio**: open Addons and paste the manifest URL, or open `stremio://YOUR-PROJECT.vercel.app/manifest.json`. In Stremio Web, paste it in the "Addon Repository URL" box.

**The manifest URL to use is always:** `https://<your-production-domain>/manifest.json`

If you add or change environment variables later, **redeploy** (Deployments → ⋯ → Redeploy) – running deployments keep the old values.

### Optional: ship a seed of IMDb ids

Cold starts are faster if the function already knows the TMDB→IMDb mappings. While running locally, open the catalogs in Stremio so `data/id-map.json` fills up, then:

```powershell
npm run export-id-map
git add seed/id-map.seed.json
git commit -m "Add id seed"
git push
```

`seed/` is read-only data shipped with the deployment (`vercel.json` includes it). It is only a speed-up: new movies are still looked up on demand and everything works without it. Only mappings that exist are exported, so no Kannada-only filtering is affected (that always happens against live TMDB data).

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `/manifest.json` returns `500 {"err":"addon is not configured: TMDB_API_KEY is missing"}` | Add `TMDB_API_KEY` in Project → Settings → Environment Variables, then **redeploy**. |
| Catalogs are empty (`"metas":[]`) | Check **Project → Logs** (runtime logs). `TMDB rejected the API key (401)` = wrong key; `fetch failed`/timeouts = TMDB unreachable (it retries automatically; empty replies are only cached for 30 s). |
| Manifest URL asks you to log in to Vercel / returns 401 | Deployment Protection is on for that URL. Use the **production domain** from Settings → Domains rather than a per-deployment/preview URL, or adjust Settings → Deployment Protection. |
| `404 NOT_FOUND` from Vercel on every path | The rewrite isn't applied: make sure `vercel.json` and the `api/` folder are committed at the repository root and Root Directory is `./`. |
| Build error mentioning an output directory (e.g. `public`) | Framework Preset must be **Other** with empty Build/Output settings. |
| `FUNCTION_INVOCATION_TIMEOUT` | Cold start plus slow TMDB; lower `REQUEST_BUDGET_MS`, add the seed above, or check TMDB status. |
| Stremio says the addon can't be installed | Paste the full URL ending in `/manifest.json` and confirm it opens in a browser first. |
| Changes don't show up | Stremio caches addons/manifests: remove and re-install the addon; also redeploy after changing env vars. |

## Other hosts

The same code also runs on any Node host (Render, Railway, Fly.io, a VPS…) with `npm start` and `TMDB_API_KEY` set; there the disk cache works as it does locally if the host keeps its filesystem.

## Testing checklist (in Stremio)

- [ ] Addons page shows **KannadaFlix** with 4 catalogs.
- [ ] **Kannada Movies** shows posters; scroll down and more load (no repeats).
- [ ] **Latest Kannada Releases** – newest release first; nothing in the future.
- [ ] **Popular Kannada Movies** and **Top Rated Kannada Movies** load; Top Rated has no 1-vote "10/10" films.
- [ ] Everything listed is Kannada (no Hindi/Tamil/Telugu or dubbed titles).
- [ ] Open a movie: details/cast/trailer show, and Torrentio / AIOStreams list streams.
- [ ] Search a partial title (e.g. `kant`) and a Kannada-script title (e.g. `ಕಾಂತಾರ`); only Kannada films appear.
- [ ] Search for gibberish: empty result, no error.

Automated tests: `npm test` (41 tests, mock TMDB, no network needed).

After deploying to Vercel, repeat this checklist against the Vercel manifest URL.
