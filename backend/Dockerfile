FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# scripts/ is copied BEFORE the build step so the multi-target `maintenance`
# image below can ship ops one-shot jobs (scripts/retention.mjs) alongside
# dist/ + pruned runtime deps. It does not affect `npm run build` (tsc compiles
# src/ only per tsconfig include).
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Multi-target images (docker build --target <name>):
#   api          — lean Fastify server (DEFAULT: plain `docker build backend/`
#                  and compose `build: ../backend` produce this, unchanged)
#   maintenance  — ops one-shot job runner for the compose `retention` service
#                  (nightly §1.10.6 downsampling; see infra/cron/yet-retention).
#                  Ships scripts/retention.mjs + dist/ + pruned runtime deps;
#                  pg is a runtime dependency kept by `npm prune --omit=dev`.
# ---------------------------------------------------------------------------

FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
# Migrations are plain SQL shipped alongside code.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src/db ./src/db
EXPOSE 3000
# Healthcheck matches GET /healthz (Phase 0 deliverable). NOTE: the retention
# one-shot is built from the SEPARATE `maintenance` target below (no healthcheck,
# ENTRYPOINT exits after one pass), so it never trips this check.
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "dist/server.js"]

# Ops job runner: same build stage output, plus scripts/. No HEALTHCHECK — the
# container runs ONE downsampling pass and exits 0 (non-zero + message on fail).
# Args via env: DATABASE_URL, RETENTION_AGE_DAYS, RETENTION_KEEP_EVERY_N, DRY_RUN.
FROM node:20-alpine AS maintenance
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/db ./src/db
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
ENTRYPOINT ["node", "scripts/retention.mjs"]
