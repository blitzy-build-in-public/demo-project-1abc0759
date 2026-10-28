# 1. Executive Summary

## 1.1 Project Overview

Task Tracker is a new server-rendered, multi-user web application for managing personal tasks. It provides:
- sign-up and login with lockout, and server-side sessions;
- task create, edit, status change and delete, with filters and a due-date sort;
- reports with summary counts, a completions chart and CSV export.

It is a layered TypeScript monolith on Node 20.20.2, Express 4.22.3 and PostgreSQL 16.15, shipped as a non-root container. It works without JavaScript, except for the chart.

## 1.2 Completion Status

```mermaid
%%{init: {"theme":"base","themeVariables":{"pie1":"#5B39F3","pie2":"#FFFFFF","pieStrokeColor":"#B23AF2","pieOuterStrokeColor":"#B23AF2","pieTitleTextColor":"#B23AF2","pieSectionTextColor":"#A8FDD9"}}}%%
pie showData title 95.2% Complete
    "Completed Work" : 418
    "Remaining Work" : 21
```

| Metric | Value |
|---|---|
| Total Hours | 439 |
| Completed Hours (AI + Manual) | 418 (418 AI + 0 manual) |
| Remaining Hours | 21 |
| Percent Complete | 95.2% |

Completion is 418 ÷ 439 hours = **95.2%**. Only AAP-scoped and deployment work is counted.

## 1.3 Key Accomplishments

- ✅ All 15 functional requirements built; 1,228 tests pass (568 unit, 612 integration, 48 end-to-end).
- ✅ Security: bcrypt cost 12, login lockout, 8-hour and 30-minute session limits, CSRF on every POST, `no-store` on private pages.
- ✅ Owner scoping: another user's task returns the same 404 as a task that does not exist.
- ✅ Reports: summary counts, a zero-filled completions chart and table, RFC 4180 CSV with byte-order mark.
- ✅ SC12: every page loads in under 2 s with 10,000 tasks; slowest run 1,517.6 ms.
- ✅ Container runs as `node`, migrates before listening, and shuts down cleanly.
- ✅ Coverage 94.61% statements, 90.85% branches; 0 type errors; 0 production vulnerabilities.
- ✅ README covers setup, tests, performance and a pre-release checklist.

## 1.4 Critical Unresolved Issues

22 items are open:
- 2 of the 12 success criteria (SC10 and SC12) need human sign-off before release.
- 20 items are low severity: 7 untested code paths and 13 accepted caveats.

None of them stops a functional requirement from working.

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| SC12 has not been run on the reference environment (4 vCPU, 8 GB, docker compose): 1 item | It passed on the build host at 76% of the 2-second budget, but the margin on the reference hardware is unknown. | Release engineer | 2 h |
| The manual spreadsheet check for SC10 has not been done: 1 item | Tests prove the CSV bytes, but nobody has seen them opened in a spreadsheet. | QA | 1 h |
| Code paths no test exercises: 7 items (listed in Section 3) | These edge cases have been checked only by reading the code. | Developer | 4 h |
| Accepted caveats: 13 items (5 UI, 3 configuration or logging, 2 process or security, 3 tooling) | Cosmetic, hardening or development-only. | Product and developer | 4 h for the 5 UI items. The other 8 are accepted as they stand. |

## 1.5 Access Issues

No access issues identified. The database, Docker, the Node 20.20.2 toolchain and the package cache were reachable for every verification run.

## 1.6 Recommended Next Steps

1. [High] Run SC12 on the reference environment and record `test-results/perf.json`.
2. [High] Open one CSV export in a spreadsheet application to complete the manual part of SC10.
3. [Medium] Provision PostgreSQL 16, put `SESSION_SECRET` in a secret store, and add an HTTPS proxy that rate-limits `POST /signup`.
4. [Medium] Add route-level tests for the untested paths listed in Section 3.
5. [Medium] Sign off the design departures in Section 5.2.

# 2. Project Hours Breakdown

## 2.1 Completed Work Detail

| Component | Hours | Description |
|---|---|---|
| Project scaffolding and toolchain | 10 | `package.json` with 14 exact pins, strict `tsconfig.json` and `tsconfig.build.json`, `jest.config.js`, `playwright.config.ts`, `scripts/copy-assets.mjs`, `.editorconfig` and the ignore files |
| Shared kernel | 14 | `src/shared`: an injectable clock, UTC date helpers, typed errors, the status and priority values, and a JSON logger that redacts credentials |
| Data access, schema and migrations | 40 | `src/db`: the pool (UTC, type parsers, timeouts, failure mapping), owner-scoped repositories, 4 SQL migrations with checks, 9 indexes and a cascade trigger, and an advisory-locked migration runner and CLI |
| Authentication and sessions | 28 | `src/auth`: password policy, bcrypt hashing, sign-up and login, lockout under an advisory transaction lock, and server-side sessions with an 8-hour absolute and 30-minute idle limit |
| Task domain | 12 | `src/tasks`: status transitions, the `completed_at` rules, the update builder and the owner-scoped task service |
| Reports domain | 16 | `src/reports`: summary and overdue counts, zero-filled completions per day, and an RFC 4180 CSV writer with a byte-order mark and CRLF line endings |
| Web infrastructure | 22 | `src/web`: middleware order, session loading, HMAC double-submit CSRF, cookies, `no-store`, the error handler and fixed-message error pages |
| Form and parameter validation | 14 | `src/web/validation`: the sign-up, login and task forms, filters, date ranges, code-point limits and strict text checks |
| HTTP routes | 22 | The auth, task and report routers, which check in the order auth → CSRF → parameters → ownership → validation → write |
| Templates, styles and client scripts | 40 | Server-rendered pages for every state in the UI spec, `app.css`, the delete-confirm script and the SVG chart script, with markup tuned for 10,000 rows |
| Composition root | 22 | `src/config.ts`, `app.ts`, `server.ts` and `purge-job.ts`: environment validation, migrations before listening, a 15-minute purge and a shutdown drain |
| Container and compose | 8 | A multi-stage `Dockerfile` running as `node`, and `docker-compose.yml` with the db healthcheck, a test-database init script and required secrets |
| Security and resilience hardening | 16 | Statement and query timeouts mapped to 503, log redaction, strict UTF-8 form bodies, exact routing, logout cache clearing and signed-in error pages |
| Test helpers | 16 | `tests/helpers`: test database setup, the app harness, an HTTP client that handles cookies and CSRF, a fake clock, a capturing logger and a CSV parser |
| Unit tests | 24 | 10 suites with 568 tests, covering the policies, rules, CSV, dates, return paths, configuration and layering |
| Integration tests | 56 | 7 suites with 612 tests against PostgreSQL 16, covering every route, state, failure mode and schema guarantee |
| End-to-end tests | 24 | 3 Playwright specs with 48 Chromium tests, including a run with JavaScript disabled |
| Performance harness and SC12 tuning | 12 | A 10,000-task seed, `tests/perf/perf.spec.ts` with five targets, and the list-markup and index tuning that keeps every target under 2 seconds |
| README | 6 | Prerequisites, configuration, local and container runs, tests, performance, pre-release checklist, architecture and known risks |
| Runtime validation | 16 | Container start-up, curl journeys, shutdown with requests in flight, and browser checks of every page |
| **Total** | **418** | |

## 2.2 Remaining Work Detail

| Category | Hours | Priority |
|---|---|---|
| Pre-release verification: run SC12 on the reference environment (2 h) and do the manual SC10 spreadsheet check (1 h) | 3 | High |
| Production deployment: PostgreSQL 16, secrets from a secret store, an HTTPS reverse proxy and a rate limit on `POST /signup` | 8 | Medium |
| Test coverage gaps: route-level tests for the 7 untested paths in Section 3, led by U+0000 inputs, clients that disconnect mid-query, and migration lock waits | 4 | Medium |
| Design-departure sign-off: review and accept or reverse D1–D7 in Section 5.2 | 2 | Medium |
| UI polish: 44 px row buttons or a recorded acceptance, a favicon, the chart at 375 and 1280 px, the pressed-nav state, long titles | 4 | Low |
| **Total** | **21** | |

# 3. Test Results

Every suite below ran against commit `a4d7ec0` on Node 20.20.2 and PostgreSQL 16.15. In total, 1,229 tests ran (568 unit, 612 integration, 48 end-to-end and 1 performance) and none failed. A combined unit and integration run with coverage measured 94.61% of statements (1,827 of 1,931), 90.85% of branches (864 of 951), 94.93% of functions and 94.85% of lines.

| Area / Category | Framework | Tests | Passed | Failed | Coverage | What This Proves |
|---|---|---|---|---|---|---|
| Unit: domain rules and policies (`task-rules`, `password-policy`, `return-path`, `date-range`, `csv`, `session-policy`, `overdue`, `lockout`) | Jest 30.5.2 + ts-jest | 434 | 434 | 0 | tasks 97.7%, reports 98.8%, shared 97.2% statements | Status transitions, password and lockout rules, session limits, UTC dates, return-path sanitising and CSV quoting behave exactly as specified |
| Unit: configuration and layering (`config`, `architecture`) | Jest 30.5.2 | 134 | 134 | 0 | composition root 87.1% statements | Start-up refuses every invalid variable with its fixed message, and no layer imports past the one below it |
| Integration: accounts and sessions (`auth-routes`, `session`) | Jest + PostgreSQL 16.15 | 151 | 151 | 0 | auth 93.8% statements | Sign-up, login, lockout under concurrency, return paths, the idle and absolute session limits, and logout work over real HTTP |
| Integration: tasks (`task-routes`) | Jest + PostgreSQL 16.15 | 158 | 158 | 0 | routes 94.0% statements, 82.0% branches | Create, edit, status, delete, filters and sort match direct SQL queries, and other users' tasks return 404 |
| Integration: reports and CSV (`report-routes`) | Jest + PostgreSQL 16.15 | 59 | 59 | 0 | reports 98.8% statements | Summary counts, zero-filled completions, range limits and CSV bytes match the stored data |
| Integration: failures, data safety and schema (`failures`, `sensitive-data`, `schema`) | Jest + PostgreSQL 16.15 | 244 | 244 | 0 | db 94.3%, middleware 98.9% statements | The pages for 400, 403, 404, 413, 500 and 503 are correct, no secret reaches pages or logs, and constraints, indexes, migrations and shutdown hold |
| End-to-end: browser flows (`auth`, `tasks`, `reports` specs) | Playwright 1.64.1, Chromium | 48 | 48 | 0 | Not instrumented | Every journey works in a real browser, and with JavaScript disabled, including delete confirmation and the chart |
| Performance: SC12 at 10,000 tasks (`perf.spec`) | Playwright 1.64.1 | 1 (5 targets × 5 runs) | 1 | 0 | Not instrumented | The task list, reports and export each stayed under 2 seconds on every run (slowest: 1,517.6 ms) |

**Not Covered.** No test exercises the following delivered behaviour. Test each one before release:

- A client that disconnects while a `GET /tasks` or `GET /reports` query is running. The later `clientGone` checks in the task and report routes are never reached.
- U+0000 in the `POST /login` email, or in a task title or description on create or edit, sent over HTTP. Only parser-level unit tests cover these. The expected result is 400 with nothing written.
- A migration that waits on another runner's advisory lock for longer than the 4.5-second statement timeout, and so fails start-up.
- A signed-in request with a malformed or oversized form body while the database is down. The expected result is 503.
- The thread-pool guard that sets `UV_THREADPOOL_SIZE` in `src/server.ts`. It runs on every server start, but no test asserts on it.
- The fallback branch of the logger's `redactError` (`src/shared/logger.ts`).
- The `nextCompletedAt` fallback for a caller-built task with status `Done` and a null completion time.
- The manual part of SC10: opening an export in a spreadsheet application.

# 4. Runtime Validation & UI Verification

- ✅ **Start-up and configuration.** `node dist/server.js` applied the 4 migrations, logged `server listening`, and ran the purge job. An invalid `SESSION_SECRET` logged `SESSION_SECRET is required (at least 32 characters)` and exited with code 1. A second `npm run migrate` applied 0 migrations.
- ✅ **Production container.** The image builds and runs as `node` (uid 1000). `/login` returns 200 with a `csrf` cookie marked `HttpOnly`, `Secure` and `SameSite=Lax`, and there is no `X-Powered-By` header.
- ✅ **Accounts.** Sign-up redirects 303 to `/login?created=1`. Login redirects 303 to `/tasks`, which shows "Signed in as …". Logout redirects 303 to `/login` with `Clear-Site-Data: "cache"`, after which `/tasks` redirects 302 to `/login?next=%2Ftasks`.
- ✅ **Task journey.** Create redirects 303, the list carries `Cache-Control: no-store`, and marking a task Done redirects 303 to `/tasks#task-1`. A foreign or missing id returns 404, and a POST without a CSRF token returns 403.
- ✅ **Reports and export.** `/reports` renders the summary, the overdue count and the completions table. The CSV export starts with a byte-order mark and has the exact header row, and a title containing a comma is quoted. It is served as `text/csv; charset=utf-8; header=present`, as `tasks-<from>-to-<to>.csv`.
- ✅ **Browser UI.** All 48 Chromium flows pass with and without JavaScript, covering the delete dialog and the confirmation page, filters and both empty states, kept values on validation errors, and the chart drawn from the table.
- ✅ **Performance at 10,000 tasks.** Slowest runs: 1,517.6 ms for the unfiltered list, 201.0 ms for the filtered list, 82.5 ms for the 366-day report, and 206.7 ms for the 366-day export.
- ✅ **Graceful shutdown.** SIGTERM logs `shutting down`, the process exits and the port is released. This holds even with a signed-in request body only partly received.
- ⚠ **docker compose stack.** The image ran under `docker run --init` on a dedicated network. `docker compose up` on the 4 vCPU, 8 GB reference environment, where SC12 is defined, has not been run.
- ⚠ **Spreadsheet import.** Nobody has opened a CSV export in a spreadsheet application yet (the manual part of SC10).

# 5. Compliance & Quality Review

## 5.1 Compliance Matrix

| Deliverable | Benchmark | Status | Evidence |
|---|---|---|---|
| Accounts and sessions (FR-1 to FR-4) | Functional correctness, SC1–SC3 | ✅ Pass | 151 integration tests, `tests/e2e/auth.spec.ts` |
| Task management (FR-5 to FR-10) | Functional correctness, SC4–SC7 | ✅ Pass | 158 integration tests, 31 end-to-end tests |
| Reports and CSV (FR-11 to FR-14) | Functional correctness, SC8–SC10 | ⚠ Partial: the manual SC10 check is pending | 59 integration tests, `tests/unit/csv.test.ts` |
| Failure handling (FR-15) | Fixed messages and no leaks, SC11 | ✅ Pass | `tests/integration/failures.test.ts`, `sensitive-data.test.ts` |
| Security controls | bcrypt 12, CSRF, cookie flags, `no-store`, redaction | ✅ Pass | `src/web/csrf.ts`, `src/web/cookies.ts`, `src/shared/logger.ts` |
| Data isolation | Owner scoping in the data-access layer | ✅ Pass | `src/db/tasks-repo.ts`, SC7 cases |
| Performance (SC12) | Under 2 s at 10,000 tasks on the reference environment | ⚠ Partial: passed on the build host, reference run pending | `tests/perf/perf.spec.ts`, `test-results/perf.json` |
| Progressive enhancement and accessibility | Works without JavaScript, 24 px target minimum | ✅ Pass (row buttons are about 28 px, under the 44 px touch guideline) | The JavaScript-disabled end-to-end suite, `src/web/public/app.css` |
| Architecture | Layering enforced by test, `pg` only in `src/db` | ✅ Pass | `tests/unit/architecture.test.ts` |
| Code quality | Strict TypeScript, TSDoc on exports, no `console.*`, no TODO markers | ✅ Pass | `npm run typecheck` (0 errors), `tsconfig.json` |
| Dependencies | 14 exact pins, no production vulnerabilities | ✅ Pass | `package.json`; `npm audit --omit=dev` reports 0 |
| Operability and documentation | Container, migrations, configuration, README | ✅ Pass (the pre-release checklist is still unticked) | `Dockerfile`, `docker-compose.yml`, `README.md` |

## 5.2 AAP & Rule Divergences and Gaps

The AAP sets no user rules (section 0.10), and no human change requests were made. Every departure below is from the AAP itself, and none is a sanctioned divergence.

| What the AAP/Rule Required | What Was Delivered Instead | Why It Diverged | Impact | Remediation |
|---|---|---|---|---|
| D1. Row buttons join `#task-actions` through `form="task-actions"` (0.5.5) | The buttons are nested inside the form (`task-pages.ts:225–231`) | SC12: the attribute form took about 29 s at 10,000 rows | Same behaviour, different markup | Accept |
| D2. `parseLogInForm` calls the auth policy functions (0.5.1) | It checks presence, a 1,024-byte limit and U+0000 only (`auth-forms.ts:170`) | FR-2 and SC2 require identical failure responses | Login never reveals why credentials failed | Accept |
| D3. The 0.5.1 signatures `renderErrorPage(status, message)`, `parseTaskForm(body)` and `createLogger(out?)` | Each gained an optional argument, and `SignUpFormResult` was added | The signed-in header (0.5.5), FR-6 limits, and redaction (0.3.4) | Additive: calls written to the AAP signatures still work | Accept, or amend the interface list |
| D4. Pool and failure mapping exactly as listed (0.3.5) | Adds `statement_timeout` 4.5 s, `query_timeout` 5 s, SQLSTATEs 57014 and 55P03, and "not queryable" errors | FR-15 needs a 503 when the database stops answering | Latency is bounded, but long statements fail | Accept, or tune the constants |
| D5. Logout deletes the session and clears the cookie (0.3.4); no helmet-style headers (0.7.2) | Also expires `csrf` and sends `Clear-Site-Data: "cache"`. A logout without a cookie changes nothing | Cached pages after logout, and cross-site logout | Stronger logout | Accept |
| D6. The app reads only 4 variables (0.3.5); end-to-end tests run on port 3100 (0.9.2) | `UV_THREADPOOL_SIZE` fixed at 14, a shutdown drain, compose `init: true`, and an `E2E_PORT` override | Parallel bcrypt, PID-1 signal handling, parallel test hosts | Operational only | Accept, and document |
| D7. Redirects "to /tasks with the same filters" (0.5.4); the middleware order (0.3.2) | A `#task-<id>` fragment, a held body-parse error, a line-break hint, and a report short-circuit | Usability, and the signed-in header on 400 and 413 pages | Small, tested refinements | Accept or revert each |
| D8. SC12 on the 4 vCPU, 8 GB compose environment (0.9.3); the manual SC10 check (0.9.1) | SC12 was run on the build host; SC10 has not been done | Reference hardware was unavailable; SC10 is a human-only step not yet done | Release sign-off is incomplete | Run both (Section 2.2) |

**D1: task-list markup.** AAP 0.5.5 says each row's Mark and Delete buttons attach to the single `task-actions` form through `form="task-actions"` and `formaction`. Instead, the table sits inside that form and each button joins it by ancestry, still using `formaction` (`src/web/templates/task-pages.ts:225–231`, explained in the comment there). The reason is SC12. With 10,000 rows, Chromium's attribute-based association made the list take about 29 seconds, against about 1.2 seconds with nesting. Submission, CSRF and keyboard behaviour are unchanged, as `tests/e2e/tasks.spec.ts` and `tests/perf/perf.spec.ts` show. Accept the change, because reverting it breaks SC12.

**D2: login form parsing.** AAP 0.5.1 says `parseSignUpForm` and `parseLogInForm` "both call the auth policy functions", but only sign-up does. `parseLogInForm` (`src/web/validation/auth-forms.ts:170`) checks that both fields are present and within 1,024 bytes (line 49), and refuses U+0000 with 400. It never applies the email grammar or the password rules. Applying them would answer a malformed email differently from a wrong password. That would break FR-2 and SC2, which require the single response "Email or password is incorrect." whatever the cause. The functional requirement was given precedence over the interface note. The result is a security benefit and needs only acceptance.

**D3: optional parameters on AAP signatures.** Several 0.5.1 signatures gained an optional trailing argument: `renderErrorPage(status, message, viewer?)` (`src/web/templates/error-pages.ts:71`), `parseTaskForm(body, stored?)` (`src/web/validation/task-form.ts:164`) and `createLogger(out?, options?)` (`src/shared/logger.ts:388`). Sign-up also refines `FormResult` as `SignUpFormResult` (`auth-forms.ts:89`). Each addition serves another AAP requirement:
- `viewer` lets error pages show the signed-in header that 0.5.5 requires on every page.
- `stored` lets an unchanged title keep passing the FR-6 limits.
- `options` carries the credential redaction that 0.3.4 requires.

Every call written to the AAP signatures still compiles and behaves as specified.

**D4: database timeouts.** AAP 0.3.5 sets the pool to a maximum of 10 clients with 5,000 ms connection and 30,000 ms idle timeouts, and lists the failures that map to `DatabaseUnavailableError`. The pool also sets `statement_timeout` to 4.5 s and `query_timeout` to 5 s (`src/db/pool.ts:200–208`). The mapping adds SQLSTATEs 57014 and 55P03 and pg's "not queryable" messages (`src/db/query.ts:48`, `74–75`). Without these, a database that accepts connections but never answers would hang requests instead of returning FR-15's 503, and a timed-out write could still commit later. The trade-off is that any statement over 4.5 s fails, including a migration waiting on a lock. A `?statement_timeout=` parameter in `DATABASE_URL` also overrides the bound. Tune the constants if needed.

**D5: logout hardening.** AAP 0.3.4 says `POST /logout` deletes the session row, clears the cookie and redirects to `/login`, and 0.7.2 puts helmet-style security headers out of scope. The delivered logout also expires the `csrf` nonce and sends `Clear-Site-Data: "cache"` (`src/web/routes/auth-routes.ts:272–280`). A `POST /logout` without the `sid` cookie changes nothing. These close two gaps. First, the back button could otherwise still show private pages cached before logout, which 0.3.4's `no-store` goal forbids. Second, a cross-site page could otherwise force a logout. A normal signed-in logout behaves exactly as the AAP describes (`tests/integration/auth-routes.test.ts`). Accept the change, or drop the header if a browser you support mishandles it.

**D6: process and runtime additions.** AAP 0.3.5 says the application reads only `DATABASE_URL`, `SESSION_SECRET`, `PORT` and `NODE_ENV`, and 0.9.2 runs the end-to-end server on port 3100. Four additions go beyond that:
- The server writes `UV_THREADPOOL_SIZE=14` before bcrypt loads, overriding any operator value (`src/server.ts:327–339`). This lets ten concurrent logins hash alongside the pool's ten clients.
- Shutdown drains open connections and force-stops on a second signal.
- Compose adds `init: true` (`docker-compose.yml:37`), so signals reach Node, which would otherwise run as PID 1.
- `playwright.config.ts:38–59` accepts an `E2E_PORT` override that defaults to 3100, so test suites can run side by side.

No application setting changes. Accept these, and document the fixed thread-pool size for operators.

**D7: behaviour refinements.** Five small behaviours go beyond the AAP's wording:
- Status and delete redirects end in `#task-<id>`, so the list reopens at that row (`src/web/validation/params.ts:278–295`). 0.5.4 asks only for "303 to /tasks with the same filters".
- A form-body parse error is held and raised after `noStore` (`src/app.ts`). This extends the 0.3.2 middleware list so that 400 and 413 pages keep the signed-in header.
- `GET /reports` skips the summary query once the client has gone.
- Task hints add "(each line break counts as 2)" (`src/web/templates/task-pages.ts:340`), because browsers submit CRLF.
- Error pages stay anonymous only for a `/static` 404 and a session-load 503.

Integration or end-to-end tests cover each one. Accept or revert them individually.

**D8: pre-release checks.** AAP 0.9.3 requires SC12 to pass on the reference environment: 4 vCPU and 8 GB, running the docker compose stack. AAP 0.9.1 also makes part of SC10 a manual check that one export opens correctly in a spreadsheet application. SC12 was measured on the build host with the production image under `docker run --init`, because the reference hardware was not available. The slowest run was 1,517.6 ms against the 2,000 ms limit. The spreadsheet check is a human-only step and has not been done. The README pre-release checklist (`README.md:308–316`) is still unticked. Run both before release, as set out in Section 2.2.

# 6. Risk Assessment

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| Node.js 20.20.2 reached end of life on 2026-04-30 and receives no security fixes. The AAP pins the runtime (`engines: >=20.19.0 <21`). | Security | High | High | Plan a move to a supported LTS line as a follow-up release. Until then, watch Node advisories. | Open, accepted by the AAP |
| `Secure` cookies in production require HTTPS termination. Without it, login silently fails. Secrets come only from the environment. | Integration | High | Medium | Put the app behind a TLS proxy, take `SESSION_SECRET` and `POSTGRES_PASSWORD` from a secret store, and follow the README pre-release checklist. | Open (2.2, deployment) |
| The unfiltered `/tasks` list at 10,000 tasks peaked at 1,517.6 ms, 76% of the budget, and has not been measured on 4 vCPUs. | Technical | Medium | Medium | Run SC12 on the reference environment. Pagination is out of v1 scope if the margin is too thin. | Open (2.2, pre-release) |
| `POST /signup` is not rate-limited (each call costs a bcrypt hash at cost 12), and no CSP or security-header middleware is set. | Security | Medium | Medium | Rate-limit `POST /signup` and add CSP at the reverse proxy. Both are documented in README "Known risks". | Open (2.2, deployment) |
| CSV cells that begin with `=`, `+`, `-`, `@`, a tab or CR are exported unchanged, so a spreadsheet may treat them as formulas. This is by AAP design for SC10. | Security | Medium | Low | Keep spreadsheet prompts for formulas and external content on. Revisit escaping in a later version. | Accepted |
| There is no health endpoint, no metrics and no alerting (out of AAP scope). Logs are JSON on stdout only. | Operational | Medium | Medium | Ship stdout to the log platform, alert on `level: error`, and probe `GET /login` for liveness. | Open |
| Seven delivered paths have no test, such as a client disconnecting mid-query, U+0000 sent through routes, and a migration lock wait over 4.5 s (Section 3). | Technical | Low | Low | Add the route-level tests in Section 2.2. | Open (2.2, tests) |
| Low-severity residue: deepmerge has 6 low advisories via Jest (development-only). Playwright failure traces may hold the throwaway perf user's credentials. A cross-site POST rotates the `csrf` nonce, which breaks forms open in other tabs. | Security | Low | Low | Keep `test-results/` and `playwright-report/` gitignored and private, and upgrade Jest once a patched release exists. | Accepted |

# 7. Visual Project Status

```mermaid
%%{init: {"theme":"base","themeVariables":{"pie1":"#5B39F3","pie2":"#FFFFFF","pieStrokeColor":"#B23AF2","pieOuterStrokeColor":"#B23AF2","pieTitleTextColor":"#B23AF2","pieSectionTextColor":"#A8FDD9"}}}%%
pie showData title Project Hours Breakdown
    "Completed Work" : 418
    "Remaining Work" : 21
```

The project is 95.2% complete (418 of 439 hours). The remaining 21 hours break down by category and priority as follows:

```mermaid
%%{init: {"theme":"base","themeVariables":{"xyChart":{"plotColorPalette":"#5B39F3","titleColor":"#B23AF2"}}}}%%
xychart-beta
    title "Remaining Hours by Category"
    x-axis ["Pre-release (High)", "Deployment (Med)", "Test gaps (Med)", "Sign-off (Med)", "UI polish (Low)"]
    y-axis "Hours" 0 --> 10
    bar [3, 8, 4, 2, 4]
```

| Priority | Hours | Share of remaining |
|---|---|---|
| High | 3 | 14% |
| Medium | 14 | 67% |
| Low | 4 | 19% |
| **Total** | **21** | **100%** |

# 8. Summary & Recommendations

Task Tracker is 95.2% complete: 418 of 439 hours are done and 21 hours remain. All 15 functional requirements are built and verified. They cover accounts with lockout, server-side sessions, owner-scoped task management, and reports with a chart and CSV export, delivered as a layered TypeScript monolith in a non-root container. All 1,229 tests pass against real PostgreSQL and Chromium. Coverage is 94.61% of statements and 90.85% of branches, strict typecheck reports 0 errors, and production dependencies have 0 known vulnerabilities. Runtime checks covered the path from sign-up to logout, the CSV download, container start-up and graceful shutdown.

The remaining work is release sign-off and deployment, not missing features. Two of the 12 success criteria still need a human step. SC12 must be re-measured on the 4 vCPU, 8 GB reference environment. On the build host the unfiltered list peaked at 1,517.6 ms, inside the 2-second limit but with only 24% headroom. SC10 needs one export opened in a spreadsheet application. Seven edge paths, listed in Section 3, have no test. Thirteen low-severity caveats are accepted, and only the five UI items among them carry hours.

The project departs from the AAP's wording in eight places (Section 5.2). Seven are design choices that serve other AAP requirements. Examples are task-list markup tuned for SC12, a login parser that keeps FR-2's single failure message, and database timeouts that make FR-15's 503 reliable. The eighth is the pending pre-release checks. None of these reduces functionality, but each should be reviewed and accepted explicitly.

The critical path to production starts with running SC12 on the reference environment and doing the SC10 spreadsheet check (3 h). Next comes provisioning PostgreSQL 16, a secret store, and an HTTPS reverse proxy that rate-limits `POST /signup` (8 h). The last steps are signing off the design departures (2 h) and ticking the README pre-release checklist. Release is ready when all four checklist boxes are ticked, a reference-environment `perf.json` shows every run under 2,000 ms, and the first deployment behind TLS is clean.

**Production readiness:** the application is ready for staging now. It is ready for production once the High and Medium items in Section 2.2 are done. The main standing risk, which the AAP accepts, is that Node.js 20 is past end of life, so schedule the runtime upgrade as the first follow-up release.

# 9. Development Guide

## 9.1 System Prerequisites

- Linux or macOS on x86-64 or arm64. The SC12 reference host has 4 vCPU, 8 GB RAM and an SSD.
- Node.js **20.20.2** with npm 10.8.2. The `engines` field requires `>=20.19.0 <21`, so Node 22 is refused. Check with `node --version`.
- Docker Engine with Compose v2 (`docker compose`), for PostgreSQL 16.15 and the production image.
- Chromium for Playwright, installed once per test host with `npx playwright install --with-deps chromium`.
- Ports: 3000 for the app, 5432 for PostgreSQL, and 3100 for the end-to-end server (change it with `E2E_PORT`).

## 9.2 Environment Setup

The application reads only environment variables. `src/config.ts` validates them at start-up, and the first invalid one logs its message and exits with code 1.

```bash
# from the repository root
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into SESSION_SECRET
# set POSTGRES_PASSWORD (letters and digits only), and use the same password inside DATABASE_URL
docker compose up -d db        # postgres:16.15-bookworm on :5432; init script also creates tasktracker_test
```

- Integration and end-to-end tests ignore `.env`. They read `DATABASE_URL` from the shell and refuse any database whose name does not end in `_test`.
- Never commit `.env`. It is gitignored.

## 9.3 Dependency Installation

```bash
npm ci --no-audit --no-fund    # installs the 14 exact pins from package-lock.json
npm run typecheck              # expected: exits 0 with no output (strict tsc; there is no ESLint)
npm run build                  # expected: "copy-assets: src/db/migrations -> dist/db/migrations"
                               #           "copy-assets: src/web/public -> dist/web/public"
```

## 9.4 Application Startup

To run on the host, set the variables explicitly or fill in `.env`:

```bash
export DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm run migrate                # expected JSON log: "migrations applied","count":4 (0 on re-run)
PORT=3000 NODE_ENV=development nohup node dist/server.js > server.log 2>&1 & echo $!
# or, with .env filled in:  npm run start:local
```

The server logs `migrations applied`, then `server listening` with `"port":3000`, then `purge completed`. It applies any pending migrations before it listens, so `npm run migrate` is optional.

To run the production container stack, which is also the SC12 reference set-up:

```bash
docker compose up -d --build   # app on :3000 (NODE_ENV=production, user node), db on :5432
```

To stop a server running on the host, use its pid (`kill <pid>`) or its port (`kill "$(lsof -ti :3000)"`). Send the signal to `node`, not to npm, because npm does not forward it.

## 9.5 Verification Steps

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login       # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3000/tasks   # 302 .../login?next=%2Ftasks
CI=true npm run test:unit                                                   # 10 suites, 568 passed
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm run test:integration   # 7 suites, 612 passed (~4 min)
DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker_test CI=true npm run test:e2e           # 48 passed (~40 s)
npm audit --omit=dev                                                        # found 0 vulnerabilities
```

Performance check (SC12), run against the compose stack:

```bash
PERF_BASE_URL=http://localhost:3000 DATABASE_URL=postgres://tasktracker:<password>@localhost:5432/tasktracker CI=true npm run test:perf
# prints min/median/max per target and writes test-results/perf.json; every run must be < 2000 ms
```

## 9.6 Example Usage

This scripted browser session uses a cookie jar and the `_csrf` token from each form:

```bash
B=http://127.0.0.1:3000; J=$(mktemp)
tok(){ grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//'; }
T=$(curl -s -c $J -b $J $B/signup | tok)
curl -s -o /dev/null -w '%{http_code}\n' -c $J -b $J --data-urlencode "_csrf=$T" \
  --data-urlencode "email=demo@example.com" --data-urlencode "password=correcthorse1" $B/signup   # 303 -> /login?created=1
T=$(curl -s -c $J -b $J $B/login | tok)
curl -s -o /dev/null -w '%{http_code}\n' -c $J -b $J --data-urlencode "_csrf=$T" \
  --data-urlencode "email=demo@example.com" --data-urlencode "password=correcthorse1" $B/login    # 303 -> /tasks
T=$(curl -s -c $J -b $J $B/tasks/new | tok)
curl -s -o /dev/null -w '%{http_code}\n' -c $J -b $J --data-urlencode "_csrf=$T" \
  --data-urlencode "title=Write release notes, v1" --data-urlencode "status=To do" \
  --data-urlencode "priority=High" --data-urlencode "dueDate=2026-11-02" $B/tasks/new           # 303 -> /tasks
D=$(date -u +%F); curl -s -b $J "$B/reports/export?from=$D&to=$D"
# id,title,description,status,priority,due date,created time,completed time
# 1,"Write release notes, v1",,To do,High,2026-11-02,<created ISO time>,
```

## 9.7 Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| `npm ci` fails with `EBADENGINE`, or behaviour differs | The Node version is not 20.x | Put Node 20.20.2 first on `PATH`. |
| `SESSION_SECRET is required (at least 32 characters)`, then exit 1 | The secret is missing or shorter than 32 characters | Generate one with the `crypto.randomBytes(32)` command. |
| `NODE_ENV must be production, development or test` | `NODE_ENV=` is set to an empty or unknown value | Unset it, or use one of the three values. |
| `Refusing to use database "<name>": its name must end in _test` | The tests point at a database that is not a test database | Use `.../tasktracker_test`. The suites truncate tables and recreate `public`. |
| Every page returns 503 "Service temporarily unavailable" | The database is unreachable, or a statement ran longer than 4.5 s | Check `docker compose ps db`, and the host and password in `DATABASE_URL`. |
| Login works over curl, but the browser shows the login form again | `NODE_ENV=production` sets `Secure` cookies, and the origin is neither HTTPS nor localhost | Serve over HTTPS, or use `http://localhost`. |
| A form submission returns 403 "The form has expired…" | The CSRF nonce was rotated, for example by a cross-site POST or a restart with a new secret | Reload the page and submit again. |
| `tasktracker_test` does not exist | The `db-data` volume is older than the init script | `docker compose exec db psql -U tasktracker -d tasktracker -c "CREATE DATABASE tasktracker_test"` |
| The server keeps running after `kill` was sent to the `npm start` process | npm does not forward signals to `node` | `kill "$(lsof -ti :3000)"`, or run `node dist/server.js` directly. |

# 10. Appendices

## A. Command Reference

| Command | Purpose |
|---|---|
| `npm ci --no-audit --no-fund` | Install the exact dependency set |
| `npm run typecheck` | Strict `tsc --noEmit` over sources and tests (the lint gate) |
| `npm run build` | Compile to `dist/` and copy the migrations and `public/` assets |
| `npm run migrate` / `npm run migrate:local` | Apply pending migrations (exit 0 ok, 1 failure, 2 bad arguments) |
| `npm start` / `npm run start:local` | Start `node dist/server.js`, reading the environment directly or through `.env` |
| `npm run test:unit` | 10 unit suites (568 tests), no database needed |
| `npm run test:integration` | 7 integration suites (612 tests), run serially against a `_test` database |
| `npm test` | Unit and then integration |
| `npm run test:e2e` | Build, then 48 Playwright Chromium tests |
| `npm run test:perf` | The SC12 check against `PERF_BASE_URL` |
| `npx jest --coverage --runInBand` | Informational coverage report written to `coverage/` |
| `npm audit --omit=dev` | Production dependency audit (0 findings) |

## B. Port Reference

| Port | Service |
|---|---|
| 3000 | Application (`PORT` default; the compose `app` service) |
| 5432 | PostgreSQL 16.15 (the compose `db` service) |
| 3100 | End-to-end server started by Playwright (override with `E2E_PORT`) |

## C. Key File Locations

| Path | Contents |
|---|---|
| `src/server.ts`, `src/app.ts`, `src/config.ts`, `src/purge-job.ts` | Composition root: entry point, middleware order, configuration, purge job |
| `src/db/` | Pool, query helper, repositories, `migrate.ts`, `migrate-cli.ts`, `migrations/0001–0004_*.sql` |
| `src/auth/`, `src/tasks/`, `src/reports/` | Business rules and services |
| `src/shared/` | Clock, UTC dates, errors, logger, status and priority values |
| `src/web/` | Routes, middleware, CSRF, cookies, validation, templates, `public/` (CSS and 2 scripts) |
| `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/perf/`, `tests/helpers/` | Test suites and shared harness |
| `Dockerfile`, `docker-compose.yml`, `docker/postgres/init-test-db.sql` | Container image and local stack |
| `.env.example`, `README.md` | Configuration template and operator documentation |

## D. Technology Versions

| Component | Version |
|---|---|
| Node.js / npm | 20.20.2 / 10.8.2 |
| TypeScript | 6.0.3 |
| Express | 4.22.3 |
| pg (node-postgres) | 8.23.1 |
| bcrypt | 6.0.0 |
| cookie-parser | 1.4.7 |
| PostgreSQL | 16.15 (`postgres:16.15-bookworm`) |
| Jest / ts-jest | 30.5.2 / 29.4.14 |
| Playwright | 1.64.1 (Chromium) |
| Base image | `node:20.20.2-bookworm-slim` |

## E. Environment Variable Reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | None | Must start with `postgres://` or `postgresql://`. This is the only connection source, and `PG*` variables are ignored. |
| `SESSION_SECRET` | Yes | None | At least 32 characters. Keys the `sid` signature and the CSRF HMAC, so rotating it logs every user out. |
| `PORT` | No | `3000` | Decimal digits only, from 1 to 65535. |
| `NODE_ENV` | No | `development` | `production`, `development` or `test`. `production` adds `Secure` to cookies, and an empty value is refused. |
| `POSTGRES_PASSWORD` | Compose only | None | The `db` service password. Use letters and digits only. |
| `E2E_PORT` | Tests only | `3100` | Port for the Playwright end-to-end server. |
| `PERF_BASE_URL` | Tests only | Unset | When set, Playwright measures the running app instead of starting one. |

## F. Developer Tools Guide

- **Layering guard.** `tests/unit/architecture.test.ts` fails the unit run if a module imports past the layer below it, or if `pg` is used outside `src/db`.
- **Fake clock.** Integration tests inject a controllable clock (`tests/helpers/`) for the lockout, session and overdue rules. Use it rather than real timers.
- **HTTP harness.** The test HTTP client keeps cookies and scrapes `_csrf` tokens. Reuse it for new route tests, such as the U+0000 cases in Section 2.2.
- **Logs.** The server writes one JSON object per line to stdout, with database credentials redacted. Use `npm start --silent` to drop npm's banner.
- **No linter.** Strict `tsc` is the gate. Keep TSDoc on every exported symbol.

## G. Glossary

| Term | Meaning |
|---|---|
| SC1–SC12 | The AAP's twelve release success criteria (SC10 is the CSV spreadsheet check, SC12 the 10,000-task performance check) |
| FR-1–FR-15 | The AAP's functional requirements |
| Double-submit CSRF | A `csrf` nonce cookie plus an HMAC token in each form. Both must match on every POST. |
| Owner scoping | Every task query takes the owner id first, so another user's task is indistinguishable from a missing one |
| Lockout | 5 failed logins within 15 minutes refuse that email for 15 minutes |
| Purge job | Deletes expired sessions and old login attempts at start-up and every 15 minutes |
| `no-store` | The `Cache-Control` value on authenticated responses, so private pages are never cached |
