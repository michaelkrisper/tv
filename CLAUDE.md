# CLAUDE.md

Installable web app: what is on TV right now and at 20:15 (today, tomorrow, the day
after) for German and Austrian channels. The app is one hand-written HTML file
(`src/index.html`, vanilla JS + inline CSS, no framework, no app build). A Node build
script turns the epgshare01 XMLTV feeds into one programme file for the API (Go) and channel
logos in `dist/`. The own server (https://tv.krisperapps.de/) builds and serves it by itself: a
systemd timer runs `npm run build` on the latest version tag every three hours, and the
Deploy workflow's "krisperapps.de" job starts that build after a merge.

## Commands

Node 26 (`.nvmrc`); Go 1.24+ for the API service in `server/`.

```sh
npm ci
npm run lint                      # Biome format + lint check (npm run lint:fix applies fixes)
npm test                          # node:test unit tests (tests/*.test.mjs), offline
npm run test:api                  # go vet + go test for server/
npm run check                     # lint + unit tests + test:api = ci.yml
npm run build                     # downloads both feeds (~60 MB each), writes dist/
npm run serve                     # serves dist/ with gzip like the live site, builds and starts the API for /api/, PORT (default 8080)
npx playwright install chromium   # once
npm run test:e2e                  # Playwright against dist/ (port 8081); build first
```

- `ci.yml` = lint + unit tests + API tests. `deploy.yml` calls `ci.yml`, then build (as a check,
  not published), Playwright, version tag, the server trigger and a curl check of the
  live site.
- The build fails on purpose with fewer than 20 channels for today (broken source):
  nothing is deployed and the previous version stays online.
- E2E uses the real data of the last build and asserts behaviour, never specific
  programmes. It runs with a Pixel 7 profile, `de-AT`, `Europe/Vienna`.

## Architecture

- `scripts/epg.mjs`: pure XMLTV parsing and selection (no network, no fs), covered by
  unit tests. Regex-based on purpose: a real XML parser is far slower on 60 MB.
- `scripts/build.mjs`: fetch feeds -> `collect()` per feed -> `merge()` -> logos ->
  `write()`. Feed order in `FEEDS` is priority: DE first, AT fills gaps. Duplicate
  channels across feeds are mapped via `ALIAS` (keys/values are `slug()`s), display
  names via `NAMES`. Logos come from tv-logo/tv-logos, trimmed with sharp and cached in
  `.cache/` (also cached in CI).
- iOS launch images: `splash()` in the build writes `dist/splash/*.png` (light/dark per
  iPhone size) and replaces `<!-- splash -->` in `index.html` with the link tags. Not
  precached. Copying `src/index.html` to `dist/` for quick E2E runs drops them.
- Platform variants: the head script sets `html[data-os=ios|android]` (desktop: none);
  CSS and JS branch on it for tap feedback, transitions, settings sheet, haptics.
- Output: the programme goes into one file (`scripts/data.mjs`; `.db/tv.tsv` or `TV_DATA`,
  never inside `dist/`), replaced atomically: a JSON head line, then one tab-separated
  line per item and schedule row. `server/main.go` reads it: one static Go binary
  (`net/http`, Brotli as its only dependency) that keeps the whole programme in memory,
  uses rows and details straight from the file's buffer and keeps compressed answers
  per query. The server compiles it in `tv-build` when `server/` changed.
  `api/start?ch=` = everything the lists need for the selected channels (20:15 items,
  today's rows from the current hour), `api/details?ch=` = the texts, fetched once while
  idle, `api/day?ch=&date=` = one whole day on tap. Answers depend only on build, hour and
  query, hence the ETag without building the answer. `FORMAT` (`data.mjs`) and `format`
  (`main.go`) must change together.
  Rows are positional arrays: the layout in `write()`/`writeSchedules()` and its reader
  in `src/index.html` must change together.
- The client reads only the API (no static fallback since #38); when it fails, the list
  shows an error. The last `api/start` answer is also kept in `localStorage` (`tv.start`)
  and drawn synchronously on start, before the request, if it is for the same channels
  and still has today. Server files and install steps: `deploy/`.
- Images are built ahead: `images()` fetches the originals of everything running within
  24 hours after the build and of the 20:15 programmes of all days, downsizes them with
  sharp to WebP and caches them in `.cache/img`: `dist/img/t/` (320 px, lists) and, for
  the 24 hours only, `dist/img/h/` (1080 px, detail page). The client applies the same
  24-hour rule to `built` (`ahead()`); the file name is the source URL (`thumbName()` in
  `scripts/epg.mjs` and `own()` in `src/index.html` must change together). A missing
  file falls back to the live image (`data-fb`). Later programmes load live from fairu
  (`?width=`) or wsrv.nl (resize/crop to WebP); both send CORS headers, so the service
  worker caches them. `TV_AHEAD` (hours) shortens the window; CI uses 1.
- `src/sw.js`: precached shell (cache `tv-shell-<version>`), cache-first images (capped),
  stale-while-revalidate API answers with a change notice; of `api/start` and `api/details` only
  the latest answer is kept and used offline for any channel selection. The build
  replaces `__VERSION__` with a hash over the shell files only, not the data, so data
  builds do not force every device to refetch the shell. The build also only writes the
  shell into `dist/` when its sources or the version changed (mark in `.cache/shell`);
  data runs refresh the programme file and `dist/img/`. Installed apps check for a new
  worker themselves and reload once.
- Times are always computed in `Europe/Vienna`; the server's timer rebuilds every three
  hours (00:30, 03:30, ... 21:30), the 00:30 run brings the third day. The timer unit
  only exists on the server (`/etc/systemd/system/tv-build.timer`).

## Conventions

- Biome only covers `src/sw.js`, `scripts/`, `server/`, `tests/`, root `*.mjs`/`*.json`.
  `src/index.html` is not linted: keep its compact style (dense one-line CSS rules,
  short names) and check it by running the E2E tests.
- UI text German; code, comments, identifiers, commit messages English.
- Dev dependencies only (Biome, Playwright, sharp); the API's one Go dependency is the
  Brotli encoder (the standard library only has gzip). No runtime dependencies, no
  framework, no bundler for the app: that was an explicit decision for load speed.
- The API is public: validate every parameter (`parseIds`, `parseQuery`), keep answers
  bounded, set no cookies, log nothing about requests.

## Rules and pitfalls

- Keep the first start including idle prefetch under 2 MB; an E2E test enforces it.
  Prefetch is skipped with data saver (`navigator.connection.saveData`).
- iOS 26 blurs the top edge of installed web apps. Tried and dropped: fixed header at
  the top, list in its own scroll container, 1-px scroll nudge. Current solution:
  navigation at the bottom, an opaque fixed `.edge` strip at the top and a per-device
  "Abstand oben" slider (`localStorage` `tv.top`). Playwright cannot reproduce the
  blur; do not iterate on it without a real iPhone and Web Inspector.
- iOS standalone mode reports a window short by the status bar (WebKit bug 301108);
  the bottom bar is positioned with `100vh` there. Keep that media query.
- The epgshare01 feeds have no CORS headers, so all EPG processing must stay in the
  build, never in the browser.
- Programme texts and images belong to their owners: never commit built data or
  downloaded images (`dist/`, `.cache/` are gitignored).

## Workflow

- Every change starts with a GitHub issue. Branch `<issue>-<slug>` from `main`,
  open a PR with `Closes #<issue>`. Never push to `main` directly.
- PRs auto-merge (squash) once CI and the "Linked ticket" check pass; drafts are not merged.
- Versions exist only as git tags `vX.Y.Z`. Every merge to `main` tags the next patch;
  never edit version numbers in files. Minor/major releases: Actions -> Release.
- Merging to `main` deploys to https://tv.krisperapps.de/ automatically (Deploy
  workflow); the server's timer rebuilds fresh data under the existing tag.
- Details: CONTRIBUTING.md.
