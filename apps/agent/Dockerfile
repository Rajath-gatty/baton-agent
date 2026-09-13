# apps/agent → AgentCore Runtime
#
# Build context is the REPOSITORY ROOT:
#   docker build -f apps/agent/Dockerfile .
#
# Built remotely by CodeBuild via the AgentCore CLI, which is why a local Docker
# daemon is optional for the deploy path. This file exists so the same image can
# be built and run locally for development, where AGENT_TRANSPORT=http points the
# worker at it.
#
# There is deliberately NO database client in this image. The container is
# stateless: input is a task, a payload and hydrated context; output is structured
# results plus a trace. Database credentials exist in exactly one place, and it is
# not here.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── deps ───────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter @baton/agent... --filter @baton/core

# ── build ──────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY apps/agent apps/agent
RUN pnpm --filter @baton/core build && pnpm --filter @baton/agent build

# ── runtime ────────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/.npmrc ./
COPY --from=build /repo/packages/core/package.json packages/core/
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/apps/agent/package.json apps/agent/
COPY --from=build /repo/apps/agent/dist apps/agent/dist

RUN pnpm install --frozen-lockfile --prod --filter @baton/agent... --filter @baton/core

# AgentCore convention: the container listens on 8080 and serves /invocations
# plus /ping.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ping || exit 1

WORKDIR /repo/apps/agent
CMD ["node", "dist/server.js"]
