# Task Tracker

## Overview

Task Tracker is a personal task tracker: a server-rendered Express 4 application on Node.js 20,
backed by PostgreSQL 16. Each user signs up with an email address and password and keeps a private
task list that no other user can see. Tasks have a title, description, status, priority and
optional due date, and the list filters by status and priority. Three reports cover the work: a
summary of open and overdue tasks, completions per day, and a CSV export.

Every page works with JavaScript disabled. The completions chart is the only feature that needs
JavaScript. For a valid date range the completions table is rendered server-side and remains the
report without JavaScript; an invalid range shows its validation message instead of the table and
the chart.

## Prerequisites

- Node.js 20.20.2 with npm 10 (`package.json` `engines`: `>=20.19.0 <21`).
- Docker with Compose v2 (`docker compose`).
- Chromium for Playwright, installed once per test host:

  ```bash
  npx playwright install --with-deps chromium
  ```

## Configuration

The application is configured only through environment variables. `src/config.ts` validates them
at start-up; the first invalid one logs its message, and the process exits with code 1 without
listening.

| Variable | Required | Default | Effect | Message when missing or invalid |
|----------|----------|---------|--------|---------------------------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string for the application and the migration runner. It must begin with `postgres://` or `postgresql://` and contain no whitespace; percent-encode special characters (a space as `%20`, `%` as `%25`). It must name the host, the user name (each in the URL or a `host` or `user` query parameter) and the database (in the path). It is the only source of connection settings: the driver's `PG*` variables (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` and the like) and password files (`~/.pgpass`, `PGPASSFILE`) are ignored. | `DATABASE_URL must be a postgres:// connection string` |
| `SESSION_SECRET` | Yes | — | At least 32 characters. Keys both the session-cookie signature and the CSRF HMAC, so rotating it logs every user out and expires every open form. | `SESSION_SECRET is required (at least 32 characters)` |
| `PORT` | No | `3000` | HTTP listen port. Unset or empty: `3000`; otherwise decimal digits only, from 1 to 65535, so `0x50`, `1e3` and `+80` are refused. | `PORT must be an integer between 1 and 65535` |
| `NODE_ENV` | No | `development` | Unset: `development`; otherwise exactly `production`, `development` or `test` (case-sensitive). `production` adds `Secure` to both cookies (`sid` and `csrf`); the container image sets it. An empty value is refused like any other, because it would override the image's `production` and drop `Secure`. | `NODE_ENV must be production, development or test` |

- `POSTGRES_PASSWORD` is read only by `docker-compose.yml`, as the `db` service's password and
  inside the `app` service's `DATABASE_URL`. Compose embeds it unencoded in that URL, so use
  letters and digits only. The application never reads it.
- Generate a session secret with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- Never commit `.env`: it holds real secrets and is listed in `.gitignore`. `.env.example` holds
  placeholders only, and no secret lives in the source tree.
- The application reads no other variables. All dates and times are stored and reported in UTC,
  whatever the host's time zone.
- The server sets Node's `UV_THREADPOOL_SIZE`, the size of libuv's thread pool, to 14 itself
  before it starts, replacing any value in the environment. Each login holds one of the 10 pooled
  database connections for the length of a bcrypt comparison, which runs on that thread pool, so
  10 threads let logins for different emails run in parallel up to the pool size, and libuv's
  default 4 remain for file reads and DNS lookups.

## Local development

```bash
npm ci
cp .env.example .env      # then set SESSION_SECRET, POSTGRES_PASSWORD and the password inside DATABASE_URL
docker compose up -d db
npm run build
npm run migrate:local
npm run start:local       # then open http://localhost:3000
```

- The password inside `DATABASE_URL` must equal `POSTGRES_PASSWORD`.
- The `*:local` scripts load `.env` with Node's built-in `--env-file=.env`; there is no dotenv.
  `npm start` and `npm run migrate` read only the process environment, so export the variables
  before running them.
- `npm run build` compiles `src/` to `dist/` and copies the SQL migrations and the static assets
  into it. Rebuild after every source change.
- npm runs each script (`start`, `start:local`, `migrate`, `migrate:local`) through `sh -c`, which
  passes no signal on to `node`. A signal sent to the npm process alone never reaches the server
  or the migration: `SIGTERM` ends npm with exit code 143 and leaves `node` running; after `SIGINT`,
  `node` keeps running as well, whether or not npm exits. To stop the server, signal the `node`
  process, for example the owner of its port (`kill "$(lsof -ti :3000)"`), or the whole process
  group (`kill -TERM -- -<pgid>`), as Ctrl+C in a terminal does. A process manager can instead run
  `node` directly: `node --env-file=.env dist/server.js` or `node dist/server.js`.
- npm prints a four-line banner, the script name and its command between blank lines, before the
  server's JSON-lines output. To capture JSON lines only, run `npm run --silent start:local` or
  `npm start --silent`, or run `node` directly.

## Migrations

- Migrations are versioned SQL files, `src/db/migrations/NNNN_name.sql` (a four-digit,
  zero-padded version and a lower-case snake_case name), applied in lexical order. Each file runs
  in its own transaction together with the record of its version (the file name without `.sql`)
  in `schema_migrations`.
- The server applies every pending migration before it listens. The runner holds a PostgreSQL
  advisory lock for its whole run, so replicas starting at the same moment apply each migration
  exactly once.
- The runner's statements share the pool's 4.5-second server-side statement timeout with every
  other statement: PostgreSQL cancels a statement that runs, or waits for a lock, any longer. The
  pool's 5-second client-side query timeout is the backstop for a database that stops answering.
  A migration statement that runs longer fails the run as database-unavailable, and a replica that
  waits longer than that for another replica's run exits with 1, for its restart policy to retry.
- `npm run migrate` (or `npm run migrate:local`) applies pending migrations without starting the
  server. It needs only `DATABASE_URL` and exits with 0 when every pending migration was applied
  or none was pending, 1 for an invalid `DATABASE_URL` or a failed migration, and 2 for invalid
  arguments. `npm run migrate -- --help` prints the usage.
- Never edit an applied migration. Make every schema change a new, higher-numbered file.

| Version | Creates |
|---------|---------|
| `0001_create_users` | `users`, with case-insensitive unique email |
| `0002_create_sessions` | `sessions` |
| `0003_create_tasks` | `tasks` and its owner-scoped indexes |
| `0004_create_login_attempts` | `login_attempts` and the trigger that removes a deleted user's attempts |

## Running in a container

```bash
docker compose up -d --build
```

- This builds the multi-stage `Dockerfile` (`build` and `runtime` stages, both on
  `node:20.20.2-bookworm-slim`) and starts the `app` service on port 3000 beside the `db` service
  (`postgres:16.15-bookworm` on port 5432). The runtime image runs `node dist/server.js` as user
  `node`.
- Compose reads `POSTGRES_PASSWORD` and `SESSION_SECRET` from `.env` or the shell and refuses to
  start without them. It sets the app's `DATABASE_URL` to point at `db` and fixes
  `NODE_ENV=production`; `.env` is never passed into the container, so it cannot override either.
- On top of the Node base image, the runtime stage copies only `package.json`, the compiled
  `dist/` and the production `node_modules`: no project tests, TypeScript sources, `.env` or
  secrets are copied into it.

For a standalone image, with `DATABASE_URL` naming a database host the container can reach
(`localhost` inside the container is the container itself):

```bash
docker build -t task-tracker .
docker run --init -e DATABASE_URL='postgres://tasktracker:<password>@<db-host>:5432/tasktracker' \
  -e SESSION_SECRET='<at least 32 characters>' -p 3000:3000 task-tracker
```

To apply migrations without serving, run the migration CLI in the image instead:
`docker run --rm -e DATABASE_URL='…' task-tracker node dist/db/migrate-cli.js`.

- **`Secure` cookies over plain HTTP.** In production mode both cookies carry `Secure`. Chromium
  treats `http://localhost` and `http://127.0.0.1` as trustworthy origins and accepts `Secure`
  cookies from them, so the container works locally without TLS. Any other origin must be served
  over HTTPS.
- **Start-up failures.** Invalid configuration or a failed migration, including an unreachable
  database, is logged and exits with code 1 before the server listens. The orchestrator's restart
  policy retries (`restart: unless-stopped` under compose). `SIGTERM` and `SIGINT` sent to the
  `node` process shut it down gracefully: it logs `shutting down` and exits with code 0.
  Connections without a complete request are closed at once, and requests already received
  finish first. A repeat of the same signal forces exit code 1. The exec-form `CMD` runs `node`
  with no shell in between, so `docker stop` and `docker compose stop` reach it. The init process
  (`init: true` under compose, `docker run --init`) keeps a signal sent during start-up from
  being ignored, as it would be by `node` running as PID 1. Locally, signal `node` itself or its
  process group, not npm (see Local development).

## Testing

Integration and end-to-end tests read `DATABASE_URL` from the shell, never from `.env`. In the
commands below, `<password>` is your `POSTGRES_PASSWORD`.

### Test environment variables

The test runners read these variables from the shell; they are separate from the application's
configuration above. Playwright passes `DATABASE_URL`, and the port resolved from `E2E_PORT` as
`PORT`, to the end-to-end server it starts.

| Variable | Required | Default | Validation | Effect |
|----------|----------|---------|------------|--------|
| `DATABASE_URL` | For integration tests, end-to-end tests, `npm test`, coverage and the performance check | — | Integration and end-to-end runs refuse it, before they connect, unless it is a `postgres://` or `postgresql://` URL whose database name ends in `_test` and which holds no raw space or malformed percent-escape. Unset or empty: `DATABASE_URL is not set; point it at a database whose name ends in _test`; another name: `Refusing to use database "<name>": its name must end in _test`. Only the suffix is checked, not that the database is disposable. The performance check applies no such check. | The database the tests migrate and reset, and the one the end-to-end server uses. For the performance check it names the container's database instead (see Performance check). |
| `PERF_BASE_URL` | For the performance check only | Unset | None: any nonempty value selects the performance run. | Nonempty: Playwright starts no server, skips the end-to-end global setup and the `_test` guard, runs one worker, and uses the value as the `perf` project's `baseURL`. Unset or empty: the end-to-end set-up below applies, guard included. |
| `E2E_PORT` | No | `3100` | Unset or empty: `3100`; otherwise decimal digits only, from 1 to 65535. Any other value stops Playwright as the config loads with `E2E_PORT must be an integer between 1 and 65535`. | Port of the server Playwright starts for the end-to-end tests, at `http://127.0.0.1:<port>`. The port must be free. |
| `CI` | No | Unset | Not validated. | The commands below set `CI=true` to keep the tools non-interactive. In Playwright, any nonempty value, `false` included, turns on `forbidOnly`, so a run that contains a `test.only` fails; unset or empty leaves it off. |

### Type check

```bash
npm run typecheck
```

This is the semantic gate for sources and tests: ts-jest only transpiles each file and performs no
type check.

### Unit tests

```bash
CI=true npm run test:unit
```

They cover the pure rules and the layer map, and need no database.

### Integration tests

```bash
docker compose up -d db
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm run test:integration
```

- They drive the real application in-process over HTTP against the compose `db`, with a fake clock
  for the time-dependent rules.
- The global setup refuses any `DATABASE_URL` whose database name does not end in `_test`, because
  every test truncates the application tables. It then applies the migrations.
- Use a dedicated, disposable `_test` database. Besides truncating the application tables before
  each test, the suites include a migration-bootstrap test (`tests/integration/schema.test.ts`)
  that drops and recreates the entire `public` schema, deleting every other object in it too. The
  guard checks only the name's `_test` suffix, not that the database is disposable.
- Never run integration and end-to-end tests, or two runs of either, at the same time against the
  same database; give parallel runs separate `_test` databases.
- Suites run serially (`--runInBand`) on the shared database, with a 30-second test timeout: each
  sign-up performs a real cost-12 bcrypt hash.
- `docker/postgres/init-test-db.sql` creates `tasktracker_test` only when the `db-data` volume is
  first initialised. If your volume predates it, recreate the volume, which deletes the
  development data:

  ```bash
  docker compose down -v
  docker compose up -d db
  ```

  or create the database manually:

  ```bash
  docker compose exec db psql -U tasktracker -d tasktracker -c "CREATE DATABASE tasktracker_test"
  ```

### End-to-end tests

```bash
npx playwright install --with-deps chromium    # once per host
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm run test:e2e
```

- `npm run test:e2e` builds first. As the Playwright config loads, it applies the `_test` guard to
  `DATABASE_URL` and stops with the guard's message before any server starts, so a refused
  database is never migrated, purged or truncated. Without `PERF_BASE_URL`, every Playwright
  command that loads the config needs a `_test` `DATABASE_URL`, `--list` included.
- Playwright then starts `node dist/server.js` with a random `SESSION_SECRET`, `NODE_ENV=test` and
  your `DATABASE_URL`; the server applies migrations before it listens.
- The e2e server defaults to `http://127.0.0.1:3100`. Set `E2E_PORT` to another free decimal port
  from 1 to 65535; unset or empty uses 3100. Invalid values fail as the config loads with
  `E2E_PORT must be an integer between 1 and 65535`. For example:

  ```bash
  E2E_PORT=3200 DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm run test:e2e
  ```

- Once the server answers, the global setup checks the `_test` guard again, applies any pending
  migrations and truncates the application tables once. Each test signs up its own user.
- The run deletes data like the integration tests do: give it a dedicated, disposable `_test`
  database, and never run it at the same time as an integration run or another end-to-end run on
  that database.
- The HTML report is written to `playwright-report/`, and failure traces to `test-results/`.

### Unit and integration together

```bash
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm test
```

This runs the integration suites, so the database rules under Integration tests apply.

### Coverage (informational)

```bash
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test npx jest --coverage --runInBand
```

The report covers `src/**` and is written to `coverage/`. No threshold is enforced. `--runInBand`
keeps the integration suites serial, as `npm run test:integration` does, because they share one
database. The run includes the integration suites, so the database rules under Integration tests
apply.

## Performance check (SC12)

Success criterion SC12: with 10,000 tasks for one user, the task list and each report load in
under 2 seconds.

**Reference environment:** a Linux x86-64 host with 4 vCPUs, 8 GB RAM and SSD storage, carrying no
other load; the compose stack built from the production `Dockerfile`; headless Playwright Chromium
1.64.1 on the same host.

```bash
docker compose up -d --build
PERF_BASE_URL=http://localhost:3000 DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker CI=true npm run test:perf
```

- With `PERF_BASE_URL` set, Playwright starts no server and skips the end-to-end global setup, so
  the run measures the running container. `DATABASE_URL` must name the database that container
  uses (`tasktracker` under compose); otherwise the seed fails and leaves its user in the app's
  database.
- The run signs up one `perf-<uuid>@example.test` user through `POST /signup`, inserts 10,000
  tasks for it in one SQL statement, and logs in through the browser.
- Each target gets one warm-up and five measured runs, and every measured run must be under
  2,000 ms. A page is timed to its `loadEventEnd` (Navigation Timing), the export from the click on
  "Download CSV" until the whole file has been received. Readiness is asserted after every run.

| Target | Load |
|--------|------|
| `tasks-unfiltered` | `/tasks`, all 10,000 rows |
| `tasks-to-do-high` | `/tasks?status=To%20do&priority=High` |
| `reports-default` | `/reports`, default 30-day completions range |
| `reports-366-days` | `/reports` with a 366-day range ending today |
| `export-366-days` | CSV export of the same 366-day range, all statuses |

- The min, median and max per target are printed and written to `test-results/perf.json`. The
  perf user is deleted afterwards, and the cascades remove its tasks.

## Pre-release checklist

- [ ] `npm run typecheck`, the unit, integration and end-to-end tests all pass.
- [ ] The performance check passes on the reference environment, with the min, median and max per
      URL recorded from `test-results/perf.json`.
- [ ] One CSV export, opened manually in a spreadsheet application, shows one row per task, with
      commas and line breaks kept inside their cells (the manual part of SC10).
- [ ] The image is built, and the deployment takes `SESSION_SECRET` from a secret store.

## Architecture

A layered monolith in which each layer calls only the one below it:

```text
src/web                                 routes, middleware, CSRF, validation, templates; no SQL
  -> src/auth, src/tasks, src/reports   business rules and services, independent of each other
    -> src/db                           pool, repositories, migration runner; the only pg user
      -> PostgreSQL 16
```

- `src/shared` is the shared kernel (clock, UTC dates, errors, logger, status and priority values).
  Every layer may use it, and it imports none of them.
- The composition root, `src/server.ts`, `src/app.ts`, `src/config.ts` and `src/purge-job.ts`,
  reads the configuration, wires the layers together, and schedules the purge of expired sessions
  and old login attempts.
- Owner scoping lives in `src/db/tasks-repo.ts`: every task query is filtered by the signed-in
  user's id, so another user's task is indistinguishable from a missing one (404 "Task not
  found.").
- `tests/unit/architecture.test.ts` reads every file under `src/` and fails on any import the layer
  rules forbid.

```text
src/
  server.ts app.ts config.ts purge-job.ts   composition root
  shared/                                   shared kernel
  db/                                       data access
    migrations/                             versioned SQL
  auth/  tasks/  reports/                   domain modules
  web/                                      web layer
    middleware/  routes/  validation/  templates/  public/
tests/
  unit/  integration/  e2e/  perf/  helpers/
docker/postgres/                            test-database init script
scripts/                                    build helper (copy-assets.mjs)
```

## Known risks

- **Node.js 20 is past end-of-life** (2026-04-30) and no longer receives security fixes. It is
  kept because the runtime is a fixed requirement, pinned to 20.20.2. Moving to a supported line
  is out of scope for this version.
- **CSV formula behaviour.** Cells beginning with `=`, `+`, `-`, `@`, tab or CR are exported
  unchanged, so that exported values equal the stored data (SC10). The export holds only the
  requesting user's own text. Keep the spreadsheet application's prompts for external content and
  formulas enabled.
- **Sign-up is not rate-limited.** Each sign-up costs one bcrypt hash at cost 12, so the
  deployment's reverse proxy should rate-limit `POST /signup`. Login has its built-in lockout:
  5 failures within 15 minutes refuse that email for 15 minutes.
- **No Content-Security-Policy or helmet-style security headers** are set; they are out of scope.
- **deepmerge 4.3.1 prototype poisoning** (GHSA-gcqx-w48m-w2h4, CVE-2026-93753, CWE-1321, low).
  It is a development-only dependency of Jest (`jest-config`) and absent from the production
  dependencies, so `npm audit` reports six low findings from this one advisory while
  `npm audit --omit=dev` reports none. No patched release exists, and the exact pins are kept
  rather than forcing a downgrade with `npm audit fix --force`. Keep the Jest configuration static
  and trusted: never merge external or user-supplied objects into it, and reject prototype-bearing
  keys (`__proto__`, `constructor`, `prototype`) before adding any external merge source. Upgrade
  once a compatible patched Jest or deepmerge release is published.

## Out of scope for v1

Password reset, email verification, two-factor authentication, sharing, teams, notifications, tags,
pagination, account management screens and a CI pipeline.
