# apps/web
#
# Build context is the REPOSITORY ROOT:
#   docker build -f apps/web/Dockerfile .
#
# NOTE ON MEMORY: Coolify builds on the VM, and a Next.js production build peaks
# far above a running Node process while Postgres is live on the same box. If the
# VM is small, build this image elsewhere and have Coolify pull it rather than
# build it.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── deps ───────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @baton/web... --filter @baton/core

# ── build ──────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @baton/core build && pnpm --filter @baton/web build

# ── runtime ────────────────────────────────────────────────────────────────────
# Next's standalone output resolves the pnpm workspace symlinks into real files,
# which is what makes @baton/core work here without a second install.
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/web/server.js"]
