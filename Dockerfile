# syntax=docker/dockerfile:1

# One artifact, three delivery vehicles: this image, the npx tarball and a source
# checkout all run the SAME bundle from apps/companion-cli. The runtime stage
# therefore carries no pnpm workspace and no TypeScript, only the bundle and the
# four runtime dependencies it declares external.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
# Which modules the image contains. `slim` is the default; `full` adds the
# planning cluster and the reactors. See profiles/*.json.
ARG PROFILE=slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
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
require('fs').writeFileSync('/app/runtime-package.json',JSON.stringify({name:'companion-runtime',private:true,type:'module',dependencies:p.dependencies},null,2))" 

FROM base AS runtime
ENV NODE_ENV=production
ENV COMPANION_HOME=/data
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && npm install -g @moxxy/cli \
  && rm -rf /var/lib/apt/lists/* /root/.npm
# better-sqlite3 is a native addon and undici/ws/inquirer are left external by
# the bundle, so install exactly those from the CLI's own manifest.
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --omit=peer --no-audit --no-fund && rm -rf /root/.npm
COPY --from=build /app/apps/companion-cli/dist ./dist
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
