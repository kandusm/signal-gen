# signalgen service image.
#
# This image NEVER runs migrations. Schema changes are applied by the Fly
# release command (`prisma migrate deploy`, see fly.toml), which runs once per
# deploy before the new machine takes traffic. A container that migrated on
# boot would race itself on restart and would apply schema changes from a
# machine that might then fail its health check.

FROM node:22-slim AS base
# Prisma's query engine links against OpenSSL; node:*-slim does not ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app


# --- build: full dependency tree, compile both packages --------------------
FROM base AS build

# Manifests first, so a source-only change does not re-resolve dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY apps/service/package.json apps/service/
RUN pnpm install --frozen-lockfile

COPY . .
# contract before service: the service imports its built output.
RUN pnpm --filter @signalgen/contract build \
    && pnpm --filter @signalgen/service exec prisma generate \
    && pnpm --filter @signalgen/service exec nest build


# --- prune: drop devDependencies, regenerate the client --------------------
FROM build AS prune
# Re-resolving with --prod removes the dev tree in place. The Prisma client
# lives inside node_modules, so it has to be generated again afterwards.
RUN pnpm install --frozen-lockfile --prod \
    && pnpm --filter @signalgen/service exec prisma generate \
    && rm -rf /app/apps/service/test /app/apps/service/src /app/packages/contract/test \
              /app/packages/contract/src /app/docs


# --- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune --chown=node:node /app /app

# WORKDIR is the service package so the release command in fly.toml can be the
# plain `npx prisma migrate deploy` -- the schema is found relative to here.
WORKDIR /app/apps/service

USER node
EXPOSE 3000

# Exec form: node becomes PID 1 and receives SIGTERM directly, which is what
# enableShutdownHooks() needs to close Prisma and stop the cron cleanly.
CMD ["node", "dist/main.js"]
