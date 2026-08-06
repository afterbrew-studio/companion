# syntax=docker/dockerfile:1

# One artifact, three delivery vehicles: this image, the npx tarball and a source
# checkout all run the SAME bundle from apps/companion-cli. The runtime stage
# therefore carries no pnpm workspace and no TypeScript, only the bundle and the
# four runtime dependencies it declares external.

FROM node:24-trixie-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
# Which modules the image contains. `slim` is the default; `full` adds the
# planning cluster and the reactors. See profiles/*.json.
ARG PROFILE=slim
# No python3/make/g++ here: nothing in the tree compiles at install time any
# more. `onlyBuiltDependencies` is down to esbuild, which ships a prebuilt binary.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY profiles ./profiles
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
RUN pnpm install --frozen-lockfile
RUN pnpm gen:modules --profile "$PROFILE"
# Builds every workspace package, then bundles the daemon + SPA into
# apps/companion-cli/dist: the same command that produces the npx package.
# By directory, not by package name. A rename of the published package used to
# make this filter match nothing, and `pnpm --filter` exits 0 when nothing
# matches, so the build produced no dist and failed three steps later with
# "COPY ... /app/apps/companion-cli/dist: not found". The `test -d` keeps the
# failure here even if the bundle silently no-ops again.
RUN pnpm -C apps/companion-cli run bundle && test -d apps/companion-cli/dist
# A standalone manifest with ONLY the bundle's runtime dependencies. The CLI's
# own package.json cannot be reused here: npm refuses to parse the `workspace:*`
# devDependencies even with --omit=dev.
RUN node -e "const p=require('./apps/companion-cli/package.json');\
require('fs').writeFileSync('/app/runtime-package.json',JSON.stringify({name:'companion-runtime',version:p.version,private:true,type:'module',dependencies:p.dependencies},null,2))"

FROM base AS runtime
ENV NODE_ENV=production
ENV COMPANION_HOME=/data
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
# undici/ws/inquirer are left external by the bundle, so install exactly those
# from the CLI's own manifest. All three are plain JavaScript: this stage has no
# toolchain and needs none, and the install prints no warnings. It used to carry
# better-sqlite3, whose install script (`prebuild-install || node-gyp rebuild`)
# both warned here and made a machine without python3/make/g++ compile from
# source; the database is Node's built-in `node:sqlite` now, which is why the
# base image is pinned to 24.
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --omit=peer --no-audit --no-fund && rm -rf /root/.npm
COPY --from=build /app/apps/companion-cli/dist ./dist
# Deliberately AFTER the dist copy, and this placement is the whole point.
# `npm install -g @moxxy/cli` resolves `latest` when the layer is BUILT, and up
# here with apt it sat above everything that ever changes, so Docker replayed it
# from cache on every redeploy and the image kept whatever moxxy was newest the
# day that layer was first built. An instance ran 0.35.0 for weeks against a
# published 0.35.2. Below the dist copy the layer dies whenever the app does,
# which is what "the image ships current moxxy" has to mean.
# Pin it by passing MOXXY_VERSION when a specific one is wanted.
ARG MOXXY_VERSION=latest
RUN npm install -g "@moxxy/cli@${MOXXY_VERSION}" && rm -rf /root/.npm
# The `companion` command every doc and runbook uses. The runtime manifest is
# generated from the CLI's dependencies alone, so it carries no `bin` field and
# npm installs no launcher: without this, `docker exec <c> companion module list`
# fails with "executable file not found".
RUN ln -s /app/dist/index.js /usr/local/bin/companion && chmod +x /app/dist/index.js
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# /data        Companion's own state (db, isolated moxxy home, clones).
# /root/.moxxy moxxy's daily home holding the provider credentials (vault),
#                which /data/moxxy-home symlinks to. Both must persist across
#                redeploys or moxxy loses its providers.
EXPOSE 8901
VOLUME ["/data", "/root/.moxxy"]
# Liveness probe (Coolify and plain Docker both honor it). The slim image has
# no curl/wget; node's fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COMPANION_PORT||8901)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
