# TV

[![Deploy](https://github.com/michaelkrisper/tv/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaelkrisper/tv/actions/workflows/deploy.yml)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)

Was läuft jetzt – und was um 20:15? Alle Sender aus Deutschland und Österreich
auf einen Blick, als schnelle Web-App zum Installieren.

**https://michaelkrisper.github.io/tv/**

## Funktionen

- **Jetzt**: was gerade läuft, mit Restzeit und Fortschrittsbalken
- **20:15** für heute, morgen und übermorgen, mit Senderlogo, Vorschaubild, Genre und Dauer
- **Detailseite** mit Beschreibung, Besetzung und Rollen, Regie, Jahr und IMDb-Wertung;
  darunter **Danach** mit kleinen Vorschaubildern, jeweils antippbar
- **Gesten**: zwischen den Tagen wischen, auf der Detailseite nach rechts wischen für zurück
- **Eigene Senderliste**: auswählen und per Ziehen sortieren
- **Darstellung**: hell, dunkel oder wie das Betriebssystem
- **Ein Design für alle Plattformen** (iPhone, Android, Desktop); als App installierbar,
  funktioniert offline mit dem zuletzt geladenen Stand

## Schnell und sparsam

Die App ist eine einzige HTML-Datei (Vanilla JS und CSS inline, kein Framework) und
lädt nur, was die eigenen Sender brauchen. Nach dem ersten Bild lädt sie im
Leerlauf alles vor, damit Tageswechsel und Antippen ohne Netz gehen:

| Erster Start (16 Standardsender, gzip) | |
|---|---|
| Seite, Sendungsliste, Senderlogos | ~75 KB |
| Tagesprogramme und alle Detailtexte | ~255 KB |
| Vorschaubilder für alle Tage und „Jetzt“ | ~515 KB |
| **Gesamt** | **~850 KB** |

Danach kommen nur noch die großen Bilder der geöffneten Detailseite (~30 KB). Der
Service Worker liefert alles sofort aus dem Cache und aktualisiert im Hintergrund.
Mit aktivem Datensparmodus lädt die App nichts vor. Ein Browser-Test stellt sicher,
dass der erste Start unter 1 MB bleibt.

## Wie es funktioniert

Es gibt keinen Server und keine Datenbank. Eine GitHub Action läuft bei jedem Push
und täglich um 18 Uhr:

1. lädt die XMLTV-Programmdaten für Deutschland und Österreich von
   [epgshare01](https://epgshare01.online/) (je rund 60 MB entpackt),
2. schneidet pro Sender die Sendung heraus, die um 20:15 (Europe/Vienna) läuft,
   und ergänzt Lücken aus dem jeweils anderen Feed,
3. schreibt pro Sender und Tag das ganze Tagesprogramm (für „Jetzt“ und „Danach“),
4. holt die Senderlogos aus [tv-logo/tv-logos](https://github.com/tv-logo/tv-logos)
   (transparent auf dem Bild; fast schwarze Logos bekommen einen hellen Schein),
5. testet die App im Browser und veröffentlicht alles auf GitHub Pages.

Vorschaubilder lädt die App live: fairu skaliert selbst, alles andere verkleinert
[wsrv.nl](https://wsrv.nl/) und schneidet auf 16:9 zu (WebP, ~8 KB je Vorschaubild).

### Daten

| Datei | Inhalt | Geladen |
|---|---|---|
| `data/list.json` | alle Sender und ihre 20:15-Sendungen (~26 KB gzip) | beim Start |
| `data/<datum>/<sender>.d.json` | Details zur 20:15-Sendung (~1 KB) | im Leerlauf |
| `data/<datum>/<sender>.json` | Tagesprogramm in Minuten ab 0 Uhr (~1 KB) | im Leerlauf |
| `data/<datum>/<sender>.x.json` | Details zum Tagesprogramm (~10 KB) | im Leerlauf (heute) |

### iPhone: Statusleiste

iOS 26 legt über installierte Web-Apps oben einen Weichzeichner. Den lässt WebKit
nur weg, wenn ein deckendes `position: fixed`-Element über die volle Breite an der
Oberkante liegt; dann füllt es die Statusleiste mit dessen Farbe. Neu bewertet wird
das erst, wenn das Dokument scrollt, deshalb schiebt die App es nach dem Laden
einmal unsichtbar um 1 px.

## Entwicklung

Voraussetzung: Node.js 24.

```sh
npm ci
npm run build                     # Daten holen und dist/ schreiben (~10 s)
npm run serve                     # http://localhost:8080 (mit gzip wie GitHub Pages)
npm run check                     # Lint (Biome) und Unit-Tests
npx playwright install chromium   # einmalig
npm run test:e2e                  # Browser-Tests gegen dist/
```

### Tests

- **Unit** (`tests/*.test.mjs`, `node:test`): XMLTV parsen, Zeitzonen und
  Sommerzeit, Sendernamen, Zusammenführen der Feeds
- **Browser** (`tests/e2e/`, Playwright, Chromium mit Handy-Viewport): Tage und
  Wischen, Detailseite mit „Danach“, Zurück per Knopf und Geste, Darstellung,
  Statusleisten-Streifen für iOS, keine JavaScript-Fehler, Datenmenge unter 1 MB

### Deployment

[`deploy.yml`](.github/workflows/deploy.yml) läuft als ein Job: Lint und
Unit-Tests, Build, Browser-Tests, Veröffentlichen auf GitHub Pages und eine
Kontrolle der Live-Seite. Schlägt ein Schritt fehl, bleibt die letzte Version
online. Actions laufen auf ihrer Hauptversion (`@v7`) und bekommen Updates
automatisch; neue Hauptversionen von Actions und npm-Paketen schlägt
[Dependabot](.github/dependabot.yml) wöchentlich als Pull Request vor.

## Projektstruktur

```
src/                die App, wie sie ausgeliefert wird (index.html, sw.js, Manifest, Icons)
scripts/epg.mjs     XMLTV parsen und auswählen (ohne Netz, getestet)
scripts/build.mjs   Feeds holen, Logos zuschneiden, dist/ schreiben
scripts/serve.mjs   lokaler Server für dist/
tests/              Unit-Tests (node:test)
tests/e2e/          Browser-Tests (Playwright)
```

## Daten und Rechte

Die Programmdaten stammen von epgshare01, das sie von TV-Programmzeitschriften
bezieht. Die Rechte an Texten und Bildern liegen bei den jeweiligen Anbietern;
dieses Projekt ist nur für den privaten Gebrauch gedacht.

## Lizenz

[MIT](LICENSE)
