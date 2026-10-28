/**
 * Failure responses: the 404 handler for unknown routes and the error handler that turns every
 * error into a fixed-message page.
 *
 * Every body comes from `renderErrorPage` with one of the fixed messages below or an
 * {@link HttpError}'s `publicMessage`. No error property, stack trace, SQL text, query string or
 * form field is ever rendered. The only request state a page reads is `req.user` and the
 * response's CSRF token, for the layout header: a request that reached the failure signed in gets
 * the navigation, "Signed in as <email>" and the Log out form, and any other gets the anonymous
 * header. Two failures with the same status and message are therefore byte-identical for the same
 * user and token. Both handlers are installed in every `NODE_ENV`, so Express's default handler,
 * which prints stack traces, is never reached.
 */

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

import { DatabaseUnavailableError, HttpError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { csrfTokenOf } from '../csrf';
import '../request-user';
import { renderErrorPage, type ErrorPageViewer } from '../templates/error-pages';

/** Message of the 404 page for an unknown route or a missing static asset. */
export const PAGE_NOT_FOUND_MESSAGE = 'Page not found.';

/** Message of the 400 and 413 pages for a malformed request rejected by Express or body-parser. */
export const BAD_REQUEST_MESSAGE = 'Bad request.';

/** Message of the 503 page shown while the database is unreachable. It has no trailing period. */
export const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable';

/** Message of the 500 page for any error the handler does not recognise. */
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong.';

/** The response an error maps to, and the log message it is recorded under, if any. */
interface ErrorOutcome {
  status: number;
  message: string;
  logMsg: 'database unavailable' | 'unexpected error' | null;
}

/**
 * The signed-in viewer of an error page, read only from state already in memory: `req.user`, set
 * by `loadSession`, and the CSRF token `csrf.prepare` set on `res.locals`. Neither read touches
 * the database, so the 503 page renders while it is down.
 *
 * Both must be present. A `/static` 404 arrives before session loading, and a 503 raised by
 * `loadSession` itself leaves `req.user` unset; a request that failed before `csrf.prepare` ran
 * has no token, and a Log out form without one could only be refused. A body-parser 400 or 413
 * is not such a failure: `createApp` holds it until `noStore` has run. `noStore` runs right after
 * `csrf.prepare` and before any route, so every failure that reaches this point with a user and a
 * token is already marked `Cache-Control: no-store`, and a page showing the email is never cached.
 *
 * @returns The user and token, or `undefined` for the anonymous page.
 */
function signedInViewer(req: Request, res: Response): ErrorPageViewer | undefined {
  const user = req.user;
  if (user === undefined) {
    return undefined;
  }
  const csrfToken = csrfTokenOf(res);
  return csrfToken === '' ? undefined : { user, csrfToken };
}

/**
 * Sends the error page as `text/html; charset=utf-8`, with the signed-in header when
 * {@link signedInViewer} finds a user and a CSRF token for this request, and the anonymous header
 * otherwise.
 *
 * `Content-Disposition` is removed so that an error raised after the export route set its headers
 * never makes the page download as a CSV file. Every other header already set is kept, notably
 * `Cache-Control: no-store` on a signed-in request and any cookie a middleware set or cleared.
 */
function sendErrorPage(req: Request, res: Response, status: number, message: string): void {
  res.removeHeader('Content-Disposition');
  res.status(status).type('html').send(renderErrorPage(status, message, signedInViewer(req, res)));
}

/**
 * The 4xx status carried by a client error that Express, body-parser or the router raised: an
 * integer `status` (or, failing that, `statusCode`) from 400 to 499. Examples are body-parser's
 * `entity.too.large` and `charset.unsupported`, and the router's `URIError` for a malformed
 * percent-encoding in a path parameter.
 *
 * @returns The status, or `null` when `err` carries no 4xx status.
 */
function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const raw =
    'status' in err && typeof err.status === 'number'
      ? err.status
      : 'statusCode' in err
        ? err.statusCode
        : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 499 ? raw : null;
}

/** Whether `err` is body-parser's `entity.too.large` error, read through its `type` property. */
function isEntityTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large'
  );
}

/** Maps an error to its status, its fixed message and whether it is logged. */
function classify(err: unknown): ErrorOutcome {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.publicMessage, logMsg: null };
  }
  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== null) {
    // A body over the 100 kb urlencoded limit, or with too many parameters, keeps its 413. Every
    // other client error, 415 included, is answered as a plain malformed request.
    const status = clientStatus === 413 || isEntityTooLarge(err) ? 413 : 400;
    return { status, message: BAD_REQUEST_MESSAGE, logMsg: null };
  }
  if (err instanceof DatabaseUnavailableError) {
    return { status: 503, message: SERVICE_UNAVAILABLE_MESSAGE, logMsg: 'database unavailable' };
  }
  return { status: 500, message: UNEXPECTED_ERROR_MESSAGE, logMsg: 'unexpected error' };
}

/**
 * Answers 404 "Page not found." for an unknown route or method, and for a missing `/static`
 * asset. Nothing is logged.
 *
 * The only request state it reads is `req.user` and `res.locals.csrfToken`, for the page header,
 * and it reads no cookie and queries nothing. Both are absent at `/static`, where it is mounted
 * right after `express.static` and before the cookie and session middleware, so that 404 renders
 * the anonymous page. After the routers, a signed-in request gets the signed-in header.
 */
export const notFoundHandler: RequestHandler = (req, res): void => {
  sendErrorPage(req, res, 404, PAGE_NOT_FOUND_MESSAGE);
};

/**
 * Creates the error middleware: the only place where an error becomes an HTTP response. It must
 * be mounted last.
 *
 * How each error is answered and logged:
 *
 * - {@link HttpError} (`BadRequestError`, `NotFoundError`, `CsrfError`): `err.status`,
 *   `err.publicMessage`, not logged.
 * - Express or body-parser 4xx that is `entity.too.large` or 413: 413, "Bad request.", not logged.
 * - Any other Express or body-parser 4xx: 400, "Bad request.", not logged.
 * - {@link DatabaseUnavailableError}: 503, "Service temporarily unavailable", logged as
 *   `database unavailable`.
 * - Anything else: 500, "Something went wrong.", logged as `unexpected error`.
 *
 * Only the 503 and 500 cases are logged, at `error` level, with the error and the request's
 * `method` and `path` (the path without its query string). Bodies, headers, cookies, query
 * strings and the signed-in user are never logged.
 *
 * When the response headers were already sent, the error is logged by the same rule and the
 * response is destroyed instead of rendered.
 *
 * Logging is best-effort: a logger failure never changes the response. When `logger.error`
 * throws, for example because its output stream failed, the throw is discarded and the same
 * fixed page is sent, or the same response destroyed, as if the entry had been written.
 *
 * @param logger - Receives the 503 and 500 entries. A throw from it never changes the response.
 * @returns A four-parameter Express error handler.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // All four parameters are declared: Express 4 recognises error middleware by its arity.
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const outcome = classify(err);
    if (outcome.logMsg !== null) {
      try {
        logger.error(outcome.logMsg, err, { method: req.method, path: req.path });
      } catch {
        // Dropped, neither rethrown nor passed to `next`: either would reach Express's default
        // handler, which replaces the fixed page or the destroy below with its own page and prints
        // the stack outside the logger. The logger is the only reporting channel, so a failure to
        // write to it has nowhere left to be reported.
      }
    }
    if (res.headersSent) {
      // Not delegated with `next(err)`: Express's default handler would print the stack to the
      // console, outside the logger. The partly sent response cannot become an error page, so
      // the connection is closed and the client sees a truncated response.
      res.destroy();
      return;
    }
    sendErrorPage(req, res, outcome.status, outcome.message);
  };
}
