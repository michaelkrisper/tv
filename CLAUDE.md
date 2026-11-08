# CLAUDE.md

Installable web app: what is on TV right now and at 20:15 (today, tomorrow, the day
after) for German and Austrian channels. The app is one hand-written HTML file
(`src/index.html`, vanilla JS + inline CSS, no framework, no app build). A Node build
script turns the epgshare01 XMLTV feeds into small JSON files and channel logos in
`dist/`; the Deploy workflow publishes `dist/` to GitHub Pages
(https://michaelkrisper.github.io/tv/) on every merge and twice daily by cron.

## Commands

Node 26 (`.nvmrc`).

```sh
npm ci
npm run lint                      # Biome format + lint check (npm run lint:fix applies fixes)
npm test                          # node:test unit tests (tests/*.test.mjs), offline
npm run check                     # lint + unit tests = ci.yml
npm run build                     # downloads both feeds (~60 MB each), writes dist/
npm run serve                     # serves dist/ with gzip like Pages, PORT (default 8080)
npx playwright install chromium   # once
npm run test:e2e                  # Playwright against dist/ (port 8081); build first
```

- `ci.yml` = lint + unit tests. `deploy.yml` calls `ci.yml`, then build, Playwright,
  version tag, Pages deploy and a curl check of the live site.
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
- Output: `data/list.json` (channels + 20:15 items as positional arrays with short
  keys), per day and channel `<id>.json` (schedule), `<id>.d.json` (20:15 details),
  `<id>.x.json` (schedule details). The array layout in `write()` and its reader in
  `src/index.html` must change together.
- Thumbnails are not built: the app loads them live from fairu (`?width=`) or wsrv.nl
  (resize/crop to WebP). Both send CORS headers, so the service worker caches them.
- `src/sw.js`: precached shell (cache `tv-shell-<version>`), cache-first images (capped),
  stale-while-revalidate data with a change notice. The build replaces `__VERSION__`
  with a hash over the shell files only, not the data, so data builds do not force
  every device to refetch the shell. Installed apps check for a new worker themselves
  and reload once.
- Times are always computed in `Europe/Vienna`; cron in `deploy.yml` is UTC (18:00
  CEST = 16:00 UTC, plus a run after midnight so the third day exists).

## Conventions

- Biome only covers `src/sw.js`, `scripts/`, `tests/`, root `*.mjs`/`*.json`.
  `src/index.html` is not linted: keep its compact style (dense one-line CSS rules,
  short names) and check it by running the E2E tests.
- UI text German; code, comments, identifiers, commit messages English.
- Dev dependencies only (Biome, Playwright, sharp). No runtime dependencies, no
  framework, no bundler for the app: that was an explicit decision for load speed.

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
- Scheduled workflows in public repos stop after 60 days without commits; the deploy
  job re-enables `deploy.yml` on scheduled runs. Keep that step.
- Programme texts and images belong to their owners: never commit built data or
  downloaded images (`dist/`, `.cache/` are gitignored).

## Workflow

- Every change starts with a GitHub issue. Branch `<issue>-<slug>` from `main`,
  open a PR with `Closes #<issue>`. Never push to `main` directly.
- PRs auto-merge (squash) once CI and the "Linked ticket" check pass; drafts are not merged.
- Versions exist only as git tags `vX.Y.Z`. Every merge to `main` tags the next patch;
  never edit version numbers in files. Minor/major releases: Actions -> Release.
- Merging to `main` deploys to GitHub Pages automatically (Deploy workflow; scheduled
  runs redeploy fresh data under the existing tag).
- Details: CONTRIBUTING.md.
