/**
 * The Express application factory, shared by the server entry point and the integration tests.
 *
 * This is composition-root code: it only wires the web layer to the services it is given. The web
 * layer receives service objects and configuration, never a `pg` pool, client or repository, so no
 * route handler can issue SQL. Listening, pool creation, migrations, signal handling and reading
 * the environment belong to `src/server.ts` (and to the test harness), never to this file.
 */

import path from 'node:path';

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

import type { AuthService } from './auth/auth-service';
import type { AppConfig } from './config';
import type { ReportService } from './reports/report-service';
import type { Clock } from './shared/clock';
import type { Logger } from './shared/logger';
import type { TaskService } from './tasks/task-service';
import { createCsrf } from './web/csrf';
import { createErrorHandler, notFoundHandler } from './web/middleware/error-handler';
import { loadSession } from './web/middleware/load-session';
import { noStore } from './web/middleware/no-store';
import { createAuthRouter } from './web/routes/auth-routes';
import { createReportRouter } from './web/routes/report-routes';
import { createTaskRouter } from './web/routes/task-routes';
import { assertFormBodyEncoding } from './web/validation/params';

/**
 * Body size limit for `application/x-www-form-urlencoded` forms; larger bodies are answered 413.
 */
const FORM_BODY_LIMIT = '100kb';

/**
 * Everything {@link createApp} wires together. The services already hold the data-access layer
 * and the clock, so the application never touches the database directly.
 */
export interface AppDeps {
  /** Validated configuration: `sessionSecret` keys cookie signatures and CSRF tokens. */
  config: AppConfig;
  /**
   * The clock the services were built with. The integration tests pass a fake clock here so the
   * application and its services share one notion of "now"; no web component reads it directly.
   */
  clock: Clock;
  /** Receives the error handler's `database unavailable` and `unexpected error` entries. */
  logger: Logger;
  /** Sign-up, login, session authentication and logout. */
  auth: AuthService;
  /** Owner-scoped task operations. */
  tasks: TaskService;
  /** Summary, completions and CSV export. */
  reports: ReportService;
}

/**
 * Builds the Express application. Each call returns an independent app with its own CSRF
 * middleware and routers; nothing is shared between calls, so two apps can run side by side
 * against one database as replicas do.
 *
 * Settings: flat (`simple`) query-string parsing, so nested `qs` objects never reach a handler
 * and a repeated parameter arrives as an array, which the parameter validators reject with 400;
 * no `X-Powered-By` header; and exact routing (case-sensitive and strict, here and in every
 * router), so a route or the `/static` mount matches only its own lower-case path and a variant
 * such as `/TASKS`, `/tasks/` or `/STATIC/app.css` is answered 404 "Page not found.".
 *
 * Middleware runs in this order, and the order is binding:
 * 1. `/static` assets, followed by the 404 handler at the same mount, ahead of every cookie and
 *    session middleware: asset requests never read the session or count as session activity, and
 *    a missing asset or a request there with a method other than `GET` or `HEAD` is answered 404
 *    "Page not found." at once.
 * 2. `cookieParser(SESSION_SECRET)`: verifies the signed `sid` cookie and exposes the `csrf`
 *    nonce cookie.
 * 3. `express.urlencoded` (flat parsing, 100 kb limit, {@link assertFormBodyEncoding} on the
 *    raw bytes): a malformed body, including one whose bytes or percent-escapes are not valid
 *    UTF-8, becomes 400 and an oversized one 413 through the error handler, before any route
 *    runs, so it writes nothing.
 * 4. `loadSession`: resolves `sid` to `req.user`, recording the request as session activity.
 * 5. `csrf.prepare`: issues the nonce cookie and the page token, which binds to the session when
 *    `req.user` is set and to `anon` otherwise, so it must follow `loadSession`.
 * 6. `noStore`: `Cache-Control: no-store` on every signed-in response, set before any route,
 *    404 or error page responds.
 * 7. The 404 handler for every `OPTIONS` request, ahead of every route: no route accepts the
 *    method, and Express's automatic `OPTIONS` answer (200 with an `Allow` list) never runs.
 * 8. `GET /`: 302 to `/tasks`.
 * 9. The auth, task and report routers, mounted at the root; each declares its full paths and
 *    applies its own session guard.
 * 10. The 404 handler for any other path or method.
 * 11. The error handler, last: the only place errors become responses, always with fixed
 *     messages, so Express's default handler and its stack traces are never reached.
 *
 * @param deps - Configuration, clock, logger and the three services.
 * @returns The configured application, not yet listening.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger, auth, tasks, reports } = deps;
  const app = express();

  app.set('query parser', 'simple');
  app.disable('x-powered-by');
  // Read once, when the first `app.use` below creates the application router, so they must be
  // set first. Each router sets the same options itself, because routers do not inherit them.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  // Static assets are served before cookie parsing and session loading, so they never touch the
  // session. The 404 handler mounted with them ends every request under /static that
  // express.static does not answer (a missing file, a directory, a method other than GET or HEAD)
  // instead of letting it fall through to loadSession and the routers. `redirect: false` keeps a
  // directory request such as `/static` on that 404: with no index files, the default
  // trailing-slash redirect would only lead to the same 404.
  app.use(
    '/static',
    express.static(path.join(__dirname, 'web', 'public'), { index: false, redirect: false }),
    notFoundHandler,
  );

  app.use(cookieParser(config.sessionSecret));
  // A body whose bytes or percent-escapes are not valid UTF-8 is malformed. `verify` checks the
  // raw bytes before `querystring` could store U+FFFD in their place, and body-parser passes its
  // BadRequestError, status 400 kept, to the error handler before any route runs, so nothing is
  // written.
  app.use(
    express.urlencoded({
      extended: false,
      limit: FORM_BODY_LIMIT,
      verify: (_req, _res, body): void => {
        assertFormBodyEncoding(body);
      },
    }),
  );
  app.use(loadSession(auth, config));

  const csrf = createCsrf(config.sessionSecret, config);
  app.use(csrf.prepare);
  app.use(noStore);

  // No route accepts OPTIONS, yet Express 4 answers it itself once a router holds a route for the
  // path: 200 with an `Allow` header listing that route's methods. Ending every OPTIONS request at
  // the 404 handler here, before any route, answers it like PUT or DELETE and lists no methods.
  app.use((req, res, next): void => {
    if (req.method === 'OPTIONS') {
      notFoundHandler(req, res, next);
      return;
    }
    next();
  });

  app.get('/', (_req, res): void => {
    res.redirect(302, '/tasks');
  });

  app.use(createAuthRouter({ auth, config, csrf }));
  app.use(createTaskRouter({ tasks, csrf }));
  app.use(createReportRouter({ reports }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
