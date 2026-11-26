# Server setup for the programme API

The app loads its programme only from the API: without it, it shows an error
message. These files install it.

| File                    | Installed as                                         |
| ----------------------- | ---------------------------------------------------- |
| `tv-build`              | `/usr/local/bin/tv-build` (replaces the current one) |
| `tv-build-api.conf`     | `/etc/systemd/system/tv-build.service.d/api.conf`    |
| `tv-api.service`        | `/etc/systemd/system/tv-api.service`                 |
| `tv-api-deploy.path`    | `/etc/systemd/system/tv-api-deploy.path`             |
| `tv-api-deploy.service` | `/etc/systemd/system/tv-api-deploy.service`          |
| `tv.caddy`              | `/etc/caddy/sites/tv.caddy` (replaces the current one) |

How it fits together: `tv-build` (timer and deploy key, user `tv`) writes the
programme file `/srv/apps/tv/tv.tsv` in one step and compiles `server/` to
`/srv/apps/tv/tv-api` when its source changed (needs Go: `apt install golang-go`).
`tv-api.service` runs that binary on `127.0.0.1:8811`, read-only, and loads a
new programme file by itself; the path unit restarts it only when its code changed. Caddy sends `/api/*` and the page (`/`,
`/index.html`, with the default channels' lists put in) to it and serves
everything else from `/srv/www/tv`; when the service does not answer, Caddy
serves the plain page from there.

## Install

In a root shell on the server, after the version containing these files was
deployed (the build's checkout has them):

```sh
apt install golang-go
cd /srv/build/tv/repo/deploy
install -d -o tv -g tv -m 755 /srv/apps/tv
install -m 755 tv-build /usr/local/bin/tv-build
install -d /etc/systemd/system/tv-build.service.d
install -m 644 tv-build-api.conf /etc/systemd/system/tv-build.service.d/api.conf
install -m 644 tv-api.service tv-api-deploy.path tv-api-deploy.service /etc/systemd/system/
systemctl daemon-reload
systemctl start tv-build.service     # writes /srv/apps/tv/tv.tsv and tv-api
systemctl enable --now tv-api.service tv-api-deploy.path
curl -s 'http://127.0.0.1:8811/api/start?ch=orf1' | head -c 200; echo
install -m 644 tv.caddy /etc/caddy/sites/tv.caddy
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
curl -sI --compressed 'https://tv.krisperapps.de/api/start?ch=orf1'
```

The last command must answer `200` with `content-encoding`, `etag` and
`cache-control: public, max-age=60`.

## Undo

The build no longer writes static programme files, so the API cannot be
switched off without going back to a version before #38 (tag it, then run
`tv-build`). After that: put the previous `tv.caddy` back (without the
`handle /api/*` block, with `header` and `file_server` directly in the site),
reload Caddy and `systemctl disable --now tv-api.service tv-api-deploy.path`.
