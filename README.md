# TV

Was läuft heute um 20:15 – und was läuft jetzt? Eine Seite, alle Sender, auf einen Blick.

**https://michaelkrisper.github.io/tv/**

- Pro Sender die Sendung, die um 20:15 läuft, mit Senderlogo, Vorschaubild, Genre und Dauer
- **Jetzt**: was gerade läuft, mit Restzeit und Fortschritt; Tage und Jetzt per Wischen wechseln
- Antippen zeigt Beschreibung, Besetzung mit Rollen, Regie, Jahr, IMDb-Wertung und (bei Jetzt) was danach kommt
- Heute und die nächsten drei Tage
- Sender auswählen und per Ziehen sortieren (bleibt im Browser gespeichert)
- Als App installierbar (PWA), funktioniert offline mit dem zuletzt geladenen Stand

## Wie es funktioniert

Es gibt keinen Server und keine Datenbank. Eine GitHub Action läuft bei jedem
Push und zweimal täglich:

1. lädt die XMLTV-Programmdaten für Deutschland und Österreich von
   [epgshare01](https://epgshare01.online/) (je rund 60 MB entpackt),
2. schneidet pro Sender die Sendung heraus, die um 20:15 (Europe/Vienna) läuft,
   und ergänzt Lücken aus dem jeweils anderen Feed,
3. schreibt für heute und morgen pro Sender das ganze Tagesprogramm (für
   „Jetzt“, ~1 KB gzip je Sender; Details in einer eigenen Datei),
4. lädt jedes 20:15-Vorschaubild einmal, schneidet es auf 16:9 zu und speichert
   es als AVIF (Thumbnail ~5 KB, Detailbild ~30 KB),
5. holt die Senderlogos aus [tv-logo/tv-logos](https://github.com/tv-logo/tv-logos)
   (transparent auf dem Bild; fast schwarze Logos bekommen einen hellen Schein),
6. veröffentlicht alles auf GitHub Pages.

Die Bilder der Jetzt-Ansicht lädt die App live: fairu skaliert selbst, alles
andere verkleinert [wsrv.nl](https://wsrv.nl/). Der Service Worker cacht sie.

Die App selbst ist eine einzige HTML-Datei mit Vanilla JS und CSS inline, ohne
Framework und ohne Build-Schritt. Beim Start lädt sie `data/list.json`
(~20 KB gzip, alle Sender und Tage). Details und Bilder kommen erst, wenn sie
gebraucht werden. Der Service Worker liefert alles sofort aus dem Cache und
aktualisiert im Hintergrund.

```
src/            die App, wie sie ausgeliefert wird (index.html, sw.js, Manifest, Icons)
scripts/epg.mjs XMLTV parsen und auswählen (ohne Netz, getestet)
scripts/build.mjs  Feeds holen, Bilder verkleinern, dist/ schreiben
tests/          node:test
```

## Lokal

```sh
npm ci
npm run build:fast   # ohne Bilder, ~3 s
npm run build        # mit Bildern; beim ersten Mal ~2 min, danach aus .cache/
npm run serve        # http://localhost:8080
npm run check        # Lint + Tests
```

## Daten

Die Programmdaten stammen von epgshare01, das sie von TV-Programmzeitschriften
bezieht. Die Rechte an Texten und Bildern liegen bei den jeweiligen Anbietern;
dieses Projekt ist nur für den privaten Gebrauch gedacht.

## Lizenz

[MIT](LICENSE)
