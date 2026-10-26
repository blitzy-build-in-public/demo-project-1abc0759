/**
 * Promise-aware wrapper for Express 4 route handlers and middleware.
 *
 * Express 4 calls a handler and ignores whatever it returns, catching only synchronous throws
 * (Express 4.x error-handling guide). A rejected promise from an `async` handler therefore never
 * reaches the error middleware: the request hangs and the rejection goes unhandled. Every async
 * handler in the web layer is wrapped in {@link asyncHandler}, which forwards the failure to
 * `next(err)` so the error handler renders the fixed error page.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * An Express request handler written as an `async` function. It either responds, calls `next()`,
 * or rejects; a rejection is forwarded to the error middleware by {@link asyncHandler}.
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Express treats a falsy argument to `next` as "no error" and the strings `'route'` and `'router'`
 * as instructions to skip handlers, so a promise rejected with one of these would silently
 * continue to the next route or the 404 page instead of reaching the error handler. Such reasons
 * are wrapped in an `Error` (the original kept as `cause`), as Express 5 does for rejected
 * promises; every other reason is forwarded unchanged.
 */
function toForwardedError(reason: unknown): unknown {
  if (!reason || reason === 'route' || reason === 'router') {
    return new Error('Request handler rejected without an error value', { cause: reason });
  }
  return reason;
}

/**
 * Adapts an async handler to Express 4's callback-style `RequestHandler`.
 *
 * The returned handler invokes `fn(req, res, next)` synchronously. If `fn` throws synchronously,
 * or the promise it returns rejects, the error is passed to `next(err)` exactly once, which hands
 * it to the error middleware. A resolved promise triggers nothing further: `fn` itself is
 * responsible for sending a response or calling `next()`.
 *
 * The wrapper neither logs nor writes to the response; turning errors into HTTP responses is the
 * error handler's job alone.
 *
 * @param fn - The async handler to wrap.
 * @returns A standard three-argument request handler.
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  // Declared with exactly three parameters: Express 4 treats a function of four or more as error
  // middleware and skips it for ordinary requests.
  return (req: Request, res: Response, next: NextFunction): void => {
    let pending: Promise<void>;
    try {
      pending = fn(req, res, next);
    } catch (err: unknown) {
      next(toForwardedError(err));
      return;
    }
    // An explicit catch, because Express 4 discards the promise a handler returns.
    pending.catch((err: unknown) => {
      next(toForwardedError(err));
    });
  };
}
