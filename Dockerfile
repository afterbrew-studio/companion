# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV COMPANION_HOME=/data
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && npm install -g @moxxy/cli \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/modules ./modules
# /data      — Companion's own state (db, isolated moxxy home, clones).
# /root/.moxxy — moxxy's daily home holding the provider credentials (vault),
#                which /data/moxxy-home symlinks to. Both must persist across
#                redeploys or moxxy loses its providers.
EXPOSE 8901
VOLUME ["/data", "/root/.moxxy"]
# Liveness probe (Coolify and plain Docker both honor it). The slim image has
# no curl/wget; node's fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COMPANION_PORT||8901)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "companion-api", "start"]
