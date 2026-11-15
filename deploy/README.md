# Server setup for the programme API

The app works without any of this: while `/api/` does not answer, it reads the
static files in `data/`. These files switch on the API, which answers a start
of the app in two requests instead of about 170.

| File                    | Installed as                                         |
| ----------------------- | ---------------------------------------------------- |
| `tv-build`              | `/usr/local/bin/tv-build` (replaces the current one) |
| `tv-build-api.conf`     | `/etc/systemd/system/tv-build.service.d/api.conf`    |
| `tv-api.service`        | `/etc/systemd/system/tv-api.service`                 |
| `tv-api-deploy.path`    | `/etc/systemd/system/tv-api-deploy.path`             |
| `tv-api-deploy.service` | `/etc/systemd/system/tv-api-deploy.service`          |
| `tv.caddy`              | `/etc/caddy/sites/tv.caddy` (replaces the current one) |

How it fits together: `tv-build` (timer and deploy key, user `tv`) writes the
database `/srv/apps/tv/tv.db` in one step and copies `server/api.mjs` to
`/srv/apps/tv/api.mjs` when it changed. `tv-api.service` runs that copy on
`127.0.0.1:8811`, read-only, and opens a new database by itself; the path unit
restarts it only when its code changed. Caddy sends `/api/*` to it and serves
everything else from `/srv/www/tv` as before.

## Install

In a root shell on the server, after the version containing these files was
deployed (the build's checkout has them):

```sh
cd /srv/build/tv/repo/deploy
install -d -o tv -g tv -m 755 /srv/apps/tv
install -m 755 tv-build /usr/local/bin/tv-build
install -d /etc/systemd/system/tv-build.service.d
install -m 644 tv-build-api.conf /etc/systemd/system/tv-build.service.d/api.conf
install -m 644 tv-api.service tv-api-deploy.path tv-api-deploy.service /etc/systemd/system/
systemctl daemon-reload
systemctl start tv-build.service     # writes /srv/apps/tv/tv.db and api.mjs
systemctl enable --now tv-api.service tv-api-deploy.path
curl -s 'http://127.0.0.1:8811/api/start?ch=orf1' | head -c 200; echo
install -m 644 tv.caddy /etc/caddy/sites/tv.caddy
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
curl -sI --compressed 'https://tv.krisperapps.de/api/start?ch=orf1'
```

The last command must answer `200` with `content-encoding`, `etag` and
`cache-control: public, max-age=60`.

## Undo

Put the previous `tv.caddy` back (without the `handle /api/*` block, with
`header` and `file_server` directly in the site) and reload Caddy: the app
reads the static files again. Then `systemctl disable --now tv-api.service
tv-api-deploy.path`.
