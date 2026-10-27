# syntax=docker/dockerfile:1

# Build stage: installs every dependency, compiles src/ to dist/ with the SQL migrations and
# static assets copied in, then prunes node_modules to the runtime dependencies.
FROM node:20.20.2-bookworm-slim AS build
WORKDIR /app
# The manifests are copied on their own so the installed-dependency layer stays cached until
# they change. bcrypt loads its prebuilt glibc binary, so no compiler toolchain is installed.
COPY package.json package-lock.json ./
RUN npm ci
# Both files: tsconfig.build.json extends tsconfig.json.
COPY tsconfig*.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Runtime stage: the compiled server and its runtime dependencies only, run as the unprivileged
# node user. The same base image as the build stage keeps bcrypt's native binary ABI-compatible.
# DATABASE_URL and SESSION_SECRET (required) and PORT (default 3000) are supplied at run time;
# the image holds no sources, tests or secrets.
FROM node:20.20.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /home/node/app
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Exec form makes node PID 1, so it receives SIGTERM and SIGINT and shuts down gracefully.
# The server applies pending migrations before it listens. To apply them without serving, run
# the migration CLI instead: docker run --rm -e DATABASE_URL=... <image> node dist/db/migrate-cli.js
CMD ["node", "dist/server.js"]
