# TV

[![CI](https://github.com/michaelkrisper/tv/actions/workflows/ci.yml/badge.svg)](https://github.com/michaelkrisper/tv/actions/workflows/ci.yml)
[![Deploy](https://github.com/michaelkrisper/tv/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaelkrisper/tv/actions/workflows/deploy.yml)
[![Version](https://img.shields.io/github/v/tag/michaelkrisper/tv?sort=semver&label=version)](https://github.com/michaelkrisper/tv/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 26](https://img.shields.io/badge/node-26-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Live demo](https://img.shields.io/badge/demo-tv.krisperapps.de-2ea44f)](https://tv.krisperapps.de/)

What is on right now, and what is on at 20:15 (prime time)? All TV channels of
Germany and Austria at a glance, as a fast, installable web app.

**Live demo: [tv.krisperapps.de](https://tv.krisperapps.de/)**

The user interface is in German.

## Features

- **Jetzt** (now): what is on right now, with remaining time and a progress bar
- **20:15** for today, tomorrow and the day after, with channel logo, thumbnail,
  genre and duration
- **Detail page** with description, cast and roles, director, year and IMDb
  rating; below it **Danach** (up next) with small thumbnails, each tappable
- **Gestures**: swipe between days, swipe right on the detail page to go back
- **Your own channel list**: pick channels and reorder them by dragging
- **Theme**: light, dark or follow the operating system
- **One design on every platform** (iPhone, Android, desktop); installable as
  an app and works offline with the last loaded data

## Fast and lean

The app is a single HTML file (vanilla JS and inline CSS, no framework, no
build step for the app itself) and only loads what the selected channels need.
After the first paint it prefetches everything while idle, so switching days
and tapping work without a network:

| First start (24 default channels, gzip)  |             |
| ---------------------------------------- | ----------- |
| Page, programme list, channel logos      | ~90 KB      |
| Schedules and detail texts (2 requests)  | ~80 KB      |
| Thumbnails for all days and "Jetzt"      | ~680 KB     |
| **Total**                                | **~850 KB** |

After that only the large image of a detail page is loaded, starting when its
row is touched (~45 KB).
The service worker serves everything from cache immediately and refreshes in
the background. With data saver enabled the app prefetches nothing. A browser
test reports the transfer size of the first start.

## How it works

A build script runs on the server after every merge and every three hours
(00:30, 03:30, ... 21:30 Vienna time). It

1. downloads the XMLTV programme data for Germany and Austria from
   [epgshare01](https://epgshare01.online/) (about 60 MB each, uncompressed),
2. extracts, per channel, the programme running at 20:15 (Europe/Vienna) and
   fills gaps from the other feed,
3. writes the full daily schedule per channel and day (for "Jetzt" and
   "Danach"),
4. fetches the channel logos from [tv-logo/tv-logos](https://github.com/tv-logo/tv-logos)
   (transparent on the image; near-black logos get a light glow),
5. writes the app and the logos to the folder the web server serves, and the
   programme into one file for the API.

A small read-only service ([`server/main.go`](server/main.go), one static Go
binary that keeps the programme in memory) answers with exactly what the selected channels
need: one request for the lists, a second one while idle for the texts. The
answers are compressed and carry `ETag` and `Cache-Control`; nothing about a
request is stored. The app needs the service; it does not run on plain static
hosting. Server setup: [`deploy/`](deploy/).

The images of everything running in the next 24 hours (and of the 20:15
programmes) are built ahead and come from the own server: a thumbnail and a
phone-sized detail image as WebP. Later programmes load live: fairu resizes on
its own, everything else is downsized and cropped to 16:9 by
[wsrv.nl](https://wsrv.nl/).

### API

| Request                          | Content                                                        | Loaded      |
| -------------------------------- | -------------------------------------------------------------- | ----------- |
| `api/start?ch=<ids>`             | channel list, 20:15 programmes and today's schedule from the current hour for these channels (~12 KB) | on start |
| `api/details?ch=<ids>`           | texts of the 20:15 programmes, their "Danach", texts for the next three hours (~65 KB) | when idle |
| `api/day?ch=<id>&date=<date>`    | one channel's whole day with texts (~15 KB)                    | on tap      |

### iPhone status bar

iOS 26 draws a blur over the top of installed web apps. WebKit omits it only
when an opaque `position: fixed` element spans the full width at the top edge;
it then fills the status bar with that element's colour. The app keeps such a
strip at the top and lets the document itself scroll, because Safari only
re-checks the top edge when the document scrolls. If the blur still shows on a
device, "Abstand oben" in the settings adds space above the list (stored per
device).

## Development

Requirement: Node.js 26 (see [`.nvmrc`](.nvmrc)).

```sh
npm ci
npm run build                     # fetch data and write dist/ (~10 s)
npm run serve                     # http://localhost:8080 (gzip like the live site)
npm run check                     # lint (Biome) and unit tests
npx playwright install chromium   # once
npm run test:e2e                  # browser tests against dist/
```

### Tests

- **Unit** (`tests/*.test.mjs`, `node:test`): XMLTV parsing, time zones and
  daylight saving time, channel names and their capitalisation, merging the
  feeds; the API's queries, input validation, compression and 304 answers
- **Browser** (`tests/e2e/`, Playwright, Chromium with a phone viewport): days
  and swiping, detail page with "Danach", back via button and gesture, theme,
  iOS status bar strip, no JavaScript errors, the requests of the first start, the
  programme in two requests, a message when the API fails

### Deployment

[`ci.yml`](.github/workflows/ci.yml) runs lint (Biome, including the format
check) and unit tests on every push and pull request to `main`.
[`deploy.yml`](.github/workflows/deploy.yml) calls the same CI workflow first
and only then builds, runs the browser tests, tells the server
(<https://tv.krisperapps.de/>) to build the new version and checks the live
site. If any step fails, the previous version stays online.
Pull requests run the same checks without deploying. Every tested commit on
`main` is tagged with the next patch version and only tagged commits are
deployed; bundled releases with release notes come from the Release workflow
(see [CONTRIBUTING](CONTRIBUTING.md#versions-and-releases)).
[Dependabot](.github/dependabot.yml) proposes updates for actions and npm
packages weekly (minor and patch updates grouped); like every pull request,
they are merged automatically once all checks pass.

## Project structure

```
src/                the app as served (index.html, sw.js, manifest, icons)
scripts/epg.mjs     XMLTV parsing and selection (no network, tested)
scripts/build.mjs   fetch feeds, trim logos, write dist/ and the programme file
scripts/data.mjs    the programme file for the API
scripts/serve.mjs   local server for dist/ and the API
server/main.go      read-only programme API (Go, with its tests)
deploy/             systemd units, Caddy site and build script of the server
tests/              unit tests (node:test)
tests/e2e/          browser tests (Playwright)
```

## Data and rights

The programme data comes from epgshare01, which sources it from TV listings
magazines. Rights to texts and images remain with their respective owners;
this project is intended for private use only.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
