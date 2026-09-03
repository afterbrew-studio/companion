# syntax=docker/dockerfile:1

# One artifact, three delivery vehicles: this image, the npx tarball and a source
# checkout all run the SAME bundle from apps/companion-cli. The runtime stage
# therefore carries no pnpm workspace and no TypeScript, only the bundle and the
# three runtime dependencies it declares external.

FROM node:24-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# The pinned Node digest can lag Debian's security repository. Upgrade the base
# once so every published target inherits remediated OS packages even before a
# refreshed upstream digest is available.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
# The Node image includes npm for installing an optional runtime. Keep that
# capability, but do not inherit vulnerable transitive packages from the npm
# version bundled into the base image. Dependabot tracks the image digest;
# Trivy gates this exact npm payload in CI.
ARG NPM_VERSION=12.0.2
ARG NPM_BRACE_EXPANSION_VERSION=5.0.9
ARG NPM_IP_ADDRESS_VERSION=10.3.1
ARG NPM_TAR_VERSION=7.5.22
# npm 12.0.2 still vendors these three older packages. Install their patched
# releases in isolation, then replace only npm's bundled copies. Remove each
# override once a later npm release contains its fix; Trivy will keep the
# image honest in either case.
#
# `tar` is here because CVE-2026-73566 (HIGH, denial of service via a crafted
# long path) affects the 7.5.19 npm 12.0.2 bundles. Trivy names 7.5.21 as the
# first fixed release; this pins the current one above it.
RUN npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund \
  && npm install --prefix /tmp/npm-security --no-audit --no-fund --no-package-lock \
    "brace-expansion@${NPM_BRACE_EXPANSION_VERSION}" \
    "ip-address@${NPM_IP_ADDRESS_VERSION}" \
    "tar@${NPM_TAR_VERSION}" \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    /usr/local/lib/node_modules/npm/node_modules/ip-address \
    /usr/local/lib/node_modules/npm/node_modules/tar \
  && cp -R /tmp/npm-security/node_modules/brace-expansion \
    /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
  && cp -R /tmp/npm-security/node_modules/ip-address \
    /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && cp -R /tmp/npm-security/node_modules/tar \
    /usr/local/lib/node_modules/npm/node_modules/tar \
  && rm -rf /tmp/npm-security \
  && npm cache clean --force \
  && npm --version \
  && corepack enable

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
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm gen:modules --profile "$PROFILE"
# Builds every workspace package, then bundles the daemon + SPA into
# apps/companion-cli/dist: the same command that produces the npx package.
# By directory, not by package name. A rename of the published package used to
# make this filter match nothing, and `pnpm --filter` exits 0 when nothing
# matches, so the build produced no dist and failed three steps later with
# "COPY ... /app/apps/companion-cli/dist: not found". The `test -d` keeps the
# failure here even if the bundle silently no-ops again.
RUN COMPANION_PROFILE="$PROFILE" pnpm -C apps/companion-cli run bundle && test -d apps/companion-cli/dist
# The runner agent ships from the same build, so one image tree produces both
# the control plane and the execution capacity it places work on.
RUN pnpm --filter @moxxy/companion-runner build && test -f apps/companion-runner/dist/agent.js
# A standalone manifest with ONLY the bundle's runtime dependencies. The CLI's
# own package.json cannot be reused here: npm refuses to parse the `workspace:*`
# devDependencies even with --omit=dev.
RUN node -e "const p=require('./apps/companion-cli/package.json');\
require('fs').writeFileSync('/app/runtime-package.json',JSON.stringify({name:'companion-runtime',version:p.version,private:true,type:'module',dependencies:p.dependencies},null,2))"

# ---------------------------------------------------------------------------
# The RUNNER image: extra execution capacity, and nothing else.
#
# It carries the agent plus its child bundle, and needs no Companion checkout,
# no database and no external CLI. Give it a model of its own
# (COMPANION_RUNNER_PROVIDER_*) or reach it over https so the controlling
# Companion may send one; a machine with neither refuses those runs and says
# why. Build it with: docker build --target runner -t companion-runner .
FROM base AS runner
ENV NODE_ENV=production
ENV COMPANION_RUNNER_HOME=/data
ENV HOME=/home/node
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/companion-runner/dist ./dist
# `ws` is the agent bundle's only external dependency; the child bundle inlines
# everything it needs, which is what lets this stage carry no toolchain.
RUN npm install --omit=dev --no-audit --no-fund ws \
  && rm -rf /home/node/.npm /root/.npm
RUN ln -s /app/dist/index.js /usr/local/bin/companion-runner && chmod +x /app/dist/index.js
RUN mkdir -p /data && chown node:node /data
EXPOSE 8920
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COMPANION_RUNNER_PORT||8920)+'/agent/health',{headers:{authorization:'Bearer '+(process.env.COMPANION_RUNNER_TOKEN||'')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]

# mise, pinned to the version rayf's CI runs, so an agent verifies its work with
# the same toolchain the pipeline will judge it by. Without it the repository's
# single entry point (`scripts/check.sh`) cannot run at all: an agent then hunts
# for an interpreter, hand-enumerates the individual checkers, and misses the
# pre-commit stage entirely - which is how a change reaches review having passed
# nothing that actually gates it.
#
# Fetched in its own stage and checksummed. The runtime copies one static binary
# and keeps no downloader, which is why this is not folded into that stage.
FROM base AS mise
ARG MISE_VERSION=2026.8.10
ARG MISE_SHA256=1f5e8795d24073904ef20ba70c1250ad6389d8c5672226d152e0ed24909ba72f
# uv is what mise's `pipx:` backend shells out to. Without it `mise install`
# stops on the first pipx-backed tool and installs none of the toolchain, so a
# repository pinning any of them gets no toolchain at all. Shipped as a system
# binary rather than a mise global, because the root filesystem is read-only and
# a global mise config has nowhere to live.
ARG UV_VERSION=0.12.9
ARG UV_SHA256=ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460
# Downloaded with node rather than curl: the base image already has one, and
# adding a downloader means apt, which means this stage fails whenever the build
# network cannot reach a Debian mirror - for a file fetched from GitHub. Node
# also carries its own CA bundle, so no ca-certificates package is needed.
RUN node -e "\
const fs = require('node:fs'); \
const { createHash } = require('node:crypto'); \
const version = process.env.MISE_VERSION; \
const want = process.env.MISE_SHA256; \
const url = \`https://github.com/jdx/mise/releases/download/v\${version}/mise-v\${version}-linux-x64\`; \
fetch(url).then((res) => { \
  if (!res.ok) throw new Error(\`GET \${url} -> \${res.status}\`); \
  return res.arrayBuffer(); \
}).then((body) => { \
  const bytes = Buffer.from(body); \
  const got = createHash('sha256').update(bytes).digest('hex'); \
  if (got !== want) throw new Error(\`checksum mismatch: got \${got}, want \${want}\`); \
  fs.writeFileSync('/tmp/mise', bytes, { mode: 0o755 }); \
});"
RUN node -e "\
const fs = require('node:fs'); \
const { createHash } = require('node:crypto'); \
const want = process.env.UV_SHA256; \
const url = \`https://github.com/astral-sh/uv/releases/download/\${process.env.UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz\`; \
fetch(url).then((res) => { \
  if (!res.ok) throw new Error(\`GET \${url} -> \${res.status}\`); \
  return res.arrayBuffer(); \
}).then((body) => { \
  const bytes = Buffer.from(body); \
  const got = createHash('sha256').update(bytes).digest('hex'); \
  if (got !== want) throw new Error(\`checksum mismatch: got \${got}, want \${want}\`); \
  fs.writeFileSync('/tmp/uv.tar.gz', bytes); \
});"
RUN tar -xzf /tmp/uv.tar.gz -C /tmp --strip-components=1 uv-x86_64-unknown-linux-gnu/uv \
  && chmod +x /tmp/uv

FROM base AS runtime
ENV NODE_ENV=production
ENV COMPANION_HOME=/data
ENV HOME=/home/node
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=mise /tmp/mise /tmp/uv /usr/local/bin/
# The root filesystem is read-only, so every directory mise writes to is placed
# on the data volume. That also makes an installed toolchain persist between
# runs rather than being refetched for each one.
#
# MISE_YES because nothing here is attended, and a trust prompt on a worktree
# would hang the turn rather than fail it. Trust is scoped to the worktree root:
# the paths are generated per run, and a repository's own mise.toml is exactly
# what an agent is meant to honour.
ENV MISE_DATA_DIR=/data/mise/data \
    MISE_CACHE_DIR=/data/mise/cache \
    MISE_STATE_DIR=/data/mise/state \
    MISE_YES=1 \
    MISE_TRUSTED_CONFIG_PATHS=/data/worktrees
# undici/ws/inquirer are left external by the bundle, so install exactly those
# from the CLI's own manifest. All three are plain JavaScript: this stage has no
# toolchain and needs none, and the install prints no warnings. It used to carry
# better-sqlite3, whose install script (`prebuild-install || node-gyp rebuild`)
# both warned here and made a machine without python3/make/g++ compile from
# source; the database is Node's built-in `node:sqlite` now, which is why the
# base image is pinned to 24.
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --omit=peer --no-audit --no-fund \
  && rm -rf /home/node/.npm /root/.npm
COPY --from=build /app/apps/companion-cli/dist ./dist
# Deliberately AFTER the dist copy, and this placement is the whole point.
# `npm install -g @moxxy/cli` resolves `latest` when the layer is BUILT, and up
# here with apt it sat above everything that ever changes, so Docker replayed it
# from cache on every redeploy and the image kept whatever moxxy was newest the
# day that layer was first built. An instance ran 0.35.0 for weeks against a
# published 0.35.2. Below the dist copy the layer dies whenever the app does,
# which is what "the image ships current moxxy" has to mean.
#
# The default is pinned to the qualified release so the same checkout builds
# the same image tomorrow. Override with --build-arg MOXXY_VERSION=... (or the
# MOXXY_VERSION variable through docker-compose.yml); `latest` restores the
# floating behaviour. Bump the pin by hand when qualifying a new moxxy release
# (`npm view @moxxy/cli version`): Dependabot cannot track it, because its
# docker ecosystem watches only the FROM digest and its npm ecosystem only
# package.json manifests, and a build ARG is neither.
#
# INSTALL_MOXXY=false skips it entirely, which is the point of the `cloud`
# profile: that build carries module-runtime, whose harness is a subprocess of
# this bundle, so the image needs no external agent runtime and nobody has to
# exec in and sign one in. Leave it true for slim/full, where the instance
# expects an operator-installed CLI.
ARG MOXXY_VERSION=0.37.0
ARG INSTALL_MOXXY=true
RUN if [ "$INSTALL_MOXXY" = "true" ]; then npm install -g "@moxxy/cli@${MOXXY_VERSION}"; fi \
  && rm -rf /home/node/.npm /root/.npm
# The `companion` command every doc and runbook uses. The runtime manifest is
# generated from the CLI's dependencies alone, so it carries no `bin` field and
# npm installs no launcher: without this, `docker exec <c> companion module list`
# fails with "executable file not found".
RUN ln -s /app/dist/index.js /usr/local/bin/companion && chmod +x /app/dist/index.js
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/init-volumes.sh /usr/local/bin/init-volumes.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/init-volumes.sh
# /data        Companion's own state (db, isolated moxxy home, clones).
# /home/node/.moxxy moxxy's daily home holding the provider credentials
#                     (vault), which /data/moxxy-home symlinks to. Both must
#                     persist across redeploys or moxxy loses its providers.
RUN mkdir -p /data /home/node/.moxxy && chown -R node:node /data /home/node/.moxxy
EXPOSE 8901
VOLUME ["/data", "/home/node/.moxxy"]
# Liveness probe (Coolify and plain Docker both honor it). The slim image has
# no curl/wget; node's fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COMPANION_PORT||8901)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
