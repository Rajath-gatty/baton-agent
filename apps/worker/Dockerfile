# apps/worker
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f apps/worker/Dockerfile .
# packages/core is a workspace dependency, so a context of apps/worker cannot see
# it. This is the standard pnpm-monorepo-in-Docker trap and it fails on the first
# build otherwise.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── deps ───────────────────────────────────────────────────────────────────────
# Only manifests are copied here, so a source change does not invalidate the
# dependency layer.
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @baton/worker... --filter @baton/core

# ── build ──────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY apps/worker apps/worker
# core first: the worker's exports resolve to core's dist, and tsc project
# references build it in order.
RUN pnpm --filter @baton/core build && pnpm --filter @baton/worker build

# ── runtime ────────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/.npmrc ./
COPY --from=build /repo/packages/core/package.json packages/core/
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/packages/core/drizzle packages/core/drizzle
COPY --from=build /repo/apps/worker/package.json apps/worker/
COPY --from=build /repo/apps/worker/dist apps/worker/dist

RUN pnpm install --frozen-lockfile --prod --filter @baton/worker... --filter @baton/core

# Unauthenticated /health, for Coolify's health check. Pointing a health check at
# the token-protected data API would return 401, read as unhealthy, and
# restart-loop past the worker's own backoff.
#
# The probe reads PORT so it follows the app rather than drifting from it: a
# compose file that sets PORT to anything else would otherwise leave a healthy
# container reporting unhealthy forever. Shell form, so the variable expands at
# runtime.
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8081}/health" || exit 1

WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
