# companion-landing

The marketing site behind <https://companion.moxxy.ai>. Plain HTML, CSS and one
20-line script: no framework, no build step, no webfont, no analytics, no
outbound request of any kind. `site/` is exactly what gets served.

```
site/
  index.html     the page
  styles.css     the identity in docs/brand, at web scale
  app.js         copy-to-clipboard for the install commands
  og.png         the 1200x630 link preview (source: docs/brand/og.html)
  favicon.svg    the mark tile (source: docs/brand/mark-tile.svg)
  robots.txt     indexable, unlike the app itself
  sitemap.xml
```

The brand assets are copies, not the originals. When the mark or the preview
card changes, regenerate them from `docs/brand` and copy them here.

## Local preview

```sh
docker compose -f apps/landing/compose.yaml up --build
# http://127.0.0.1:8080
```

## Deploying on Coolify

New Resource → Application → your Git source → this repository.

| Setting | Value |
| --- | --- |
| Build Pack | `Dockerfile` |
| Branch | `main` |
| Base Directory | `/apps/landing` |
| Dockerfile Location | `/apps/landing/Dockerfile` |
| Ports Exposes | `8080` |
| Domains | `https://companion.moxxy.ai` |
| Health Check Path | `/healthz` |
| Health Check Port | `8080` |

No environment variables, no persistent storage, no database. The container is
stateless; a redeploy is a full replacement.

**Base Directory matters.** It becomes the Docker build context, and the
Dockerfile copies `nginx.conf` and `site/` by relative path. Point the context
at the repository root instead and the build fails on `COPY site/`.

Before the first deploy, point `companion.moxxy.ai` at the Coolify host with an
`A` record (and `AAAA` if the host has IPv6). Coolify issues the certificate on
its own once the record resolves; the container speaks plain HTTP on 8080 and
never redirects, because TLS and HSTS belong to the proxy in front of it.

## What the container serves

`nginx.conf` sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`
and a `Content-Security-Policy` of `default-src 'none'` with `'self'` for
images, styles and scripts. The page is built to satisfy that policy: if a
future change needs a CDN, an embedded video or an analytics snippet, the policy
has to be widened deliberately rather than by accident.

Cache policy is driven by a `map` on content type rather than per-location
`add_header` blocks, because nginx drops every inherited `add_header` the moment
a block declares one of its own. Written the obvious way, the cache header on
`*.css` would have quietly stripped the security headers from the CSS.
